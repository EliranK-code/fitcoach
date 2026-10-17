import { loadConfig } from "./config";
import { logger } from "./logger";

// Cost estimates for usage_events. A price per million tokens in dollars is the same number as
// micro-dollars per token, so costs are kept as integer micro-dollars.
//
// Claude: first-party API prices (Anthropic's model reference, checked 2026-10-17). Cache writes are the
// 5-minute rate. OpenAI: from OpenAI's model pages, the transcription rate is the older published one
// (about $0.006 per minute of audio) and should be rechecked against platform.openai.com/docs/pricing.

interface TokenPrices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const CLAUDE: Record<string, TokenPrices> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Prompts up to 100K tokens; the bot's prompts stay well under that.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

const OPENAI: Record<string, TokenPrices> = {
  "text-embedding-3-small": { input: 0.02, output: 0, cacheWrite: 0, cacheRead: 0 },
  // Audio input tokens and text output tokens.
  "gpt-4o-transcribe": { input: 6, output: 10, cacheWrite: 0, cacheRead: 0 },
};

/** Unknown models (a fallback added later, say) are priced like Claude Opus 5, rather than as free. */
const UNKNOWN: TokenPrices = CLAUDE["claude-opus-5"]!;
const warned = new Set<string>();

export type MessageKind = "message_in" | "message_out" | "template";
export const MESSAGE_KINDS: readonly string[] = ["message_in", "message_out", "template"];

export interface PricedUsage {
  kind: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  quantity?: number;
}

/**
 * Estimated cost in micro-dollars. WhatsApp: messages in a customer service window are free; each template
 * is charged by Meta per country and category, so its price comes from WHATSAPP_TEMPLATE_PRICE_USD.
 */
export function estimateCostMicros(u: PricedUsage, prices: { whatsappTemplateUsd?: number } = {}): number {
  if (MESSAGE_KINDS.includes(u.kind)) {
    if (u.kind !== "template") return 0;
    const usd = prices.whatsappTemplateUsd ?? loadConfig().WHATSAPP_TEMPLATE_PRICE_USD;
    return Math.round((u.quantity ?? 0) * usd * 1_000_000);
  }
  let p = CLAUDE[u.model] ?? OPENAI[u.model];
  if (!p) {
    if (!warned.has(u.model)) {
      warned.add(u.model);
      logger.warn({ model: u.model }, "no price for this model; estimating at Claude Opus 5 rates");
    }
    p = UNKNOWN;
  }
  return Math.round(
    (u.inputTokens ?? 0) * p.input +
      (u.outputTokens ?? 0) * p.output +
      (u.cacheWriteTokens ?? 0) * p.cacheWrite +
      (u.cacheReadTokens ?? 0) * p.cacheRead,
  );
}

export const formatUsd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros >= 100_000_000 ? 0 : 2)}`;

export type BudgetLevel = "none" | "ok" | "warn" | "over";

/** The soft monthly budget: "warn" from 80%, "over" from 100%. Nothing is ever blocked. */
export function budgetStatus(costMicros: number, budgetUsd: number | undefined | null): { level: BudgetLevel; percent: number | null } {
  if (!budgetUsd || budgetUsd <= 0) return { level: "none", percent: null };
  const percent = Math.round((costMicros / (budgetUsd * 1_000_000)) * 100);
  return { level: percent >= 100 ? "over" : percent >= 80 ? "warn" : "ok", percent };
}
