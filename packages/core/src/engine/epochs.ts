import { createHash } from "node:crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { Embedder } from "../knowledge/embeddings";
import { buildKnowledgePrompt } from "../knowledge/store";
import { textOf, type BetaMessageParam, type LlmClient } from "../llm/client";
import { buildSystemBlocks, PLATFORM_RULES, renderClientContext, SUMMARY_SYSTEM } from "../llm/prompts";
import { logger } from "../logger";
import { isMinor } from "../profile";
import { getMemory, saveMemory } from "../repos/clients";
import { closeEpoch, createEpoch, getActiveEpoch, type Epoch } from "../repos/conversation";
import { recordUsage } from "../repos/ops";
import { getActiveMealPlan, getActiveWorkoutPlan } from "../repos/tracking";
import { calorieFloor } from "../safety/calories";
import type { TenantContext } from "../tenancy";
import { localDate } from "../time";
import { TOOLS, type TurnContext } from "./tools";

export interface EngineDeps {
  db: Db;
  cfg: AppConfig;
  /** Lazily created so gates that need no AI (consent, deletion) work without an API key. */
  llm: () => LlmClient;
  embedder: Embedder | null;
  now: () => Date;
}

export type RolloverReason = "knowledge_updated" | "platform_updated" | "size" | "idle" | "manual";

/**
 * Fingerprint of everything frozen into an epoch that comes from code: the platform rules and the tool
 * definitions. A deploy that changes either rolls conversations over instead of replaying old history
 * against a different prefix.
 */
export const PLATFORM_HASH = createHash("sha256").update(PLATFORM_RULES).update(JSON.stringify(TOOLS)).digest("hex").slice(0, 16);

export function rolloverReason(epoch: Epoch, t: TenantContext, cfg: AppConfig, now: Date): RolloverReason | null {
  if (epoch.row.platformHash !== PLATFORM_HASH) return "platform_updated";
  if (epoch.row.knowledgeVersion !== t.knowledgeVersion) return "knowledge_updated";
  if (epoch.row.lastContextTokens > cfg.EPOCH_MAX_TOKENS) return "size";
  const idleHours = (now.getTime() - epoch.row.lastActivityAt.getTime()) / 3600_000;
  if (epoch.messages.length > 0 && idleHours > cfg.EPOCH_IDLE_HOURS) return "idle";
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Plain-text rendering of an epoch, for the summarizer and for carrying recent context forward. */
export function renderTranscript(messages: BetaMessageParam[], maxPerItem = 1500): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role === "system" ? "[note]" : m.role === "user" ? "Client" : "Assistant"}: ${clip(m.content, maxPerItem)}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") {
        lines.push(`${m.role === "user" ? "Client" : m.role === "system" ? "[note]" : "Assistant"}: ${clip(b.text, maxPerItem)}`);
      } else if (b.type === "tool_use") {
        lines.push(`[action ${b.name}: ${clip(JSON.stringify(b.input), 400)}]`);
      } else if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        lines.push(`[result${b.is_error ? " (error)" : ""}: ${clip(content ?? "", 300)}]`);
      }
    }
  }
  return lines.join("\n");
}

function recentExchanges(messages: BetaMessageParam[], count = 8): string | null {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = typeof m.content === "string" ? m.content : textOf(m.content.filter((b) => b.type === "text"));
    if (text) texts.push(`${m.role === "user" ? "Client" : "Assistant"}: ${clip(text, 400)}`);
  }
  return texts.length ? texts.slice(-count).join("\n") : null;
}

async function summarizeEpoch(deps: EngineDeps, t: TenantContext, epoch: Epoch, previous: string | null): Promise<string> {
  const model = deps.cfg.CLAUDE_SUMMARY_MODEL ?? deps.cfg.CLAUDE_MODEL;
  const res = await deps.llm().create({
    model,
    max_tokens: 8000,
    output_config: { effort: "low" },
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `<previous_memory>\n${previous ?? "(empty)"}\n</previous_memory>\n\n<transcript>\n${renderTranscript(epoch.messages)}\n</transcript>`,
      },
    ],
  });
  await recordUsage(deps.db, t, {
    clientId: epoch.row.clientId,
    kind: "summary",
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });
  const text = res.stop_reason === "refusal" ? "" : textOf(res.content);
  if (!text) throw new Error(`Summary came back empty (stop_reason ${res.stop_reason})`);
  return text;
}

/**
 * Closes the active epoch: summarizes it into long-term memory (keeping the previous memory if the
 * summarizer fails, so a rollover never loses what we had) and carries the last exchanges forward as text.
 */
export async function closeWithSummary(deps: EngineDeps, t: TenantContext, epoch: Epoch, reason: RolloverReason): Promise<void> {
  if (epoch.messages.length > 0) {
    const memory = await getMemory(deps.db, t, epoch.row.clientId);
    let summary = memory?.summary ?? null;
    try {
      summary = await summarizeEpoch(deps, t, epoch, summary);
    } catch (err) {
      logger.error({ err, epochId: epoch.row.id }, "epoch summary failed; keeping previous memory");
    }
    await saveMemory(deps.db, t, epoch.row.clientId, summary ?? "", recentExchanges(epoch.messages));
  }
  await closeEpoch(deps.db, t, epoch.row.id, reason);
}

export async function buildEpochSystem(deps: EngineDeps, t: TenantContext, ctx: TurnContext) {
  const kp = await buildKnowledgePrompt(deps.db, t, deps.cfg.KNOWLEDGE_INLINE_MAX_TOKENS);
  const memory = await getMemory(deps.db, t, ctx.client.id);
  const meal = await getActiveMealPlan(deps.db, t, ctx.client.id);
  const workout = await getActiveWorkoutPlan(deps.db, t, ctx.client.id);
  const timeZone = t.settings.timezone ?? deps.cfg.TIMEZONE;
  const minor = Boolean(ctx.client.flags.minor) || isMinor(ctx.profile);
  const clientContext = renderClientContext({
    startedOn: localDate(deps.now(), timeZone),
    timeZone,
    profile: ctx.profile,
    flags: ctx.client.flags,
    floor: calorieFloor(ctx.profile, t.settings, { minor }),
    memorySummary: memory?.summary || null,
    recentExchanges: memory?.recent ?? null,
    activeMealPlan: meal ? meal.planText : null,
    activeWorkoutPlan: workout ? workout.planText : null,
    ragMode: kp.ragMode,
    documentTitles: kp.documentTitles,
  });
  return buildSystemBlocks(kp.text, clientContext);
}

/** Returns the client's active epoch, rolling over to a fresh one when it's stale, too large, or forced. */
export async function ensureEpoch(
  deps: EngineDeps,
  t: TenantContext,
  ctx: TurnContext,
  opts: { force?: boolean } = {},
): Promise<Epoch> {
  const active = await getActiveEpoch(deps.db, t, ctx.client.id);
  let reason: RolloverReason | null = null;
  if (active) {
    reason = opts.force ? "manual" : rolloverReason(active, t, deps.cfg, deps.now());
    if (!reason) return active;
    await closeWithSummary(deps, t, active, reason);
  }
  const system = await buildEpochSystem(deps, t, ctx);
  const epoch = await createEpoch(deps.db, t, ctx.client.id, system, PLATFORM_HASH);
  ctx.events.push({ type: "epoch", action: active ? "rolled_over" : "created", reason: reason ?? "first" });
  return epoch;
}
