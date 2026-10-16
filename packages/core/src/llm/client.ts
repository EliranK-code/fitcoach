import Anthropic from "@anthropic-ai/sdk";
import { modelSupportsFallbacks, type AppConfig } from "../config";
import { logger } from "../logger";

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
export type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type BetaTextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type BetaTool = Anthropic.Beta.BetaTool;
export type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
export type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The only thing the engine needs from Claude. Tests substitute a scripted fake. */
export interface LlmClient {
  create(params: CreateParams): Promise<BetaMessage>;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY חסר בקובץ .env. הוסיפו מפתח מ-console.anthropic.com והריצו שוב.");
  }
}

export function createAnthropicLlm(cfg: AppConfig): LlmClient {
  if (!cfg.ANTHROPIC_API_KEY) throw new MissingApiKeyError();
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 3 });
  return {
    create: (params) => client.beta.messages.create(params),
  };
}

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Request settings shared by every conversation call:
 * - adaptive thinking, with `drop_block` so an accidental history edit degrades instead of failing
 *   (the epoch design keeps history append-only; drops are logged as bugs);
 * - effort from the environment (Claude Opus 5.5 defaults to medium, so we always set it explicitly);
 * - automatic caching for the growing message tail (system blocks carry their own breakpoints);
 * - server-side refusal fallback where the model supports it.
 */
export function conversationParams(
  cfg: AppConfig,
  model: string,
): Omit<CreateParams, "messages" | "system" | "tools"> {
  const betas: Anthropic.Beta.AnthropicBeta[] = [THINKING_BINDING_BETA];
  const params: Omit<CreateParams, "messages" | "system" | "tools"> = {
    model,
    max_tokens: cfg.CLAUDE_MAX_TOKENS,
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: cfg.CLAUDE_EFFORT },
    cache_control: { type: "ephemeral" },
    betas,
  };
  if (cfg.CLAUDE_FALLBACKS === "default" && modelSupportsFallbacks(model)) {
    betas.push(FALLBACK_BETA);
    params.fallbacks = "default";
  }
  return params;
}

/**
 * Prepares a response's content for storage and replay. After a mid-output refusal fallback, the API
 * requires dropping the declined model's thinking/tool_use blocks that precede the last `fallback` block
 * (its text may stay); the `fallback` marker itself is only an audit marker.
 */
export function sanitizeAssistantContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  const kept: BetaContentBlock[] =
    lastFallback === -1
      ? content
      : [...content.slice(0, lastFallback).filter((b) => b.type === "text"), ...content.slice(lastFallback + 1)];
  return kept as unknown as BetaContentBlockParam[];
}

export function textOf(content: BetaContentBlockParam[] | BetaContentBlock[]): string {
  return (content as { type: string; text?: string }[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Everything the model saw plus what it wrote: the size the next request in this epoch will start from. */
  contextTokens: number;
}

export function summarizeUsage(msg: BetaMessage): UsageSummary {
  const u = msg.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    contextTokens: u.input_tokens + cacheRead + cacheWrite + u.output_tokens,
  };
}

/** A prefix-binding drop means our append-only history was edited somewhere: a bug worth surfacing. */
export function logInputTransformations(msg: BetaMessage, context: Record<string, unknown>): void {
  for (const tr of msg.input_transformations ?? []) {
    const reason = (tr as { reason?: string }).reason;
    if (reason === "prefix_binding_mismatch") {
      logger.warn({ ...context, transformation: tr }, "thinking block dropped: conversation prefix changed");
    } else {
      logger.info({ ...context, transformation: tr }, "input transformation");
    }
  }
}
