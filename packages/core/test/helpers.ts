import { resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type AppConfig } from "../src/config";
import { openDatabase, type DbHandle } from "../src/db/client";
import { ConversationEngine } from "../src/engine/conversation";
import { importCoachFromDir } from "../src/knowledge/importer";
import type { CreateParams, LlmClient } from "../src/llm/client";
import { SUMMARY_SYSTEM } from "../src/llm/prompts";
import { openTenant, type TenantContext } from "../src/tenancy";

type Block = Anthropic.Beta.BetaContentBlock;

export const SEED_DIR = resolve(import.meta.dirname, "../../../seed/demo-coach");

export function testConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  return loadConfig({
    CLAUDE_MODEL: "claude-opus-5-5",
    CLAUDE_SUMMARY_MODEL: "",
    CLAUDE_EFFORT: "medium",
    CLAUDE_FALLBACKS: "default",
    EPOCH_MAX_TOKENS: "24000",
    EPOCH_IDLE_HOURS: "72",
    KNOWLEDGE_INLINE_MAX_TOKENS: "30000",
    TIMEZONE: "Asia/Jerusalem",
    ...overrides,
  });
}

let counter = 0;

export function message(
  content: Block[],
  opts: { stop_reason?: Anthropic.Beta.BetaStopReason; inputTokens?: number; stop_details?: unknown } = {},
): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${++counter}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: opts.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: (opts.stop_details ?? null) as never,
    container: null,
    context_management: null,
    usage: {
      input_tokens: opts.inputTokens ?? 1200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as never,
  } as unknown as Anthropic.Beta.BetaMessage;
}

export const thinking = (): Block => ({ type: "thinking", thinking: "", signature: `sig_${++counter}` }) as Block;
export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
export const toolUse = (name: string, input: unknown): Block =>
  ({ type: "tool_use", id: `toolu_${++counter}`, name, input }) as Block;

type Responder = (params: CreateParams) => Anthropic.Beta.BetaMessage | Promise<Anthropic.Beta.BetaMessage>;

/** A scripted stand-in for Claude that records every request it receives. */
export class FakeLlm implements LlmClient {
  readonly requests: CreateParams[] = [];
  private readonly queue: Responder[] = [];
  /** Answers summary requests (system === SUMMARY_SYSTEM) without consuming the queue. */
  summary = "- מטרה: ירידה במשקל\n- מתאמן 3 פעמים בשבוע";

  push(...responders: (Responder | Anthropic.Beta.BetaMessage)[]): this {
    for (const r of responders) this.queue.push(typeof r === "function" ? r : () => r);
    return this;
  }

  get chatRequests(): CreateParams[] {
    return this.requests.filter((r) => r.system !== SUMMARY_SYSTEM);
  }

  async create(params: CreateParams): Promise<Anthropic.Beta.BetaMessage> {
    this.requests.push(structuredClone(params));
    if (params.system === SUMMARY_SYSTEM) return message([text(this.summary)]);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeLlm: no scripted response left");
    return next(params);
  }
}

export interface TestApp {
  handle: DbHandle;
  cfg: AppConfig;
  llm: FakeLlm;
  engine: ConversationEngine;
  coachId: string;
  tenant(): Promise<TenantContext>;
  clock: { now: Date };
}

export async function createTestApp(cfgOverrides: Partial<Record<keyof AppConfig, unknown>> = {}): Promise<TestApp> {
  const cfg = testConfig(cfgOverrides);
  const handle = await openDatabase({});
  const imported = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
  const llm = new FakeLlm();
  const clock = { now: new Date("2026-10-16T09:00:00Z") };
  const engine = new ConversationEngine({ db: handle.db, cfg, llm: () => llm, embedder: null, now: () => clock.now });
  return {
    handle,
    cfg,
    llm,
    engine,
    coachId: imported.coachId,
    tenant: () => openTenant(handle.db, imported.coachId),
    clock,
  };
}

/** Sends a message as the test client; on a brand-new client this triggers and then accepts the consent flow. */
export async function consentedClient(app: TestApp, phone = "0501234567") {
  await app.engine.handleInbound({ coachId: app.coachId, phone, text: "היי", channel: "cli" });
  app.llm.push(message([thinking(), text("היי! אני העוזר הדיגיטלי של גל. איך קוראים לך?")]));
  return app.engine.handleInbound({ coachId: app.coachId, phone, text: "מאשר", channel: "cli" });
}
