import { existsSync } from "node:fs";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const envSchema = z.object({
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-opus-5-5")),
  CLAUDE_SUMMARY_MODEL: optionalString,
  CLAUDE_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  ),
  CLAUDE_MAX_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(16000)),
  CLAUDE_FALLBACKS: z.preprocess(emptyToUndefined, z.enum(["default", "off"]).default("default")),

  OPENAI_API_KEY: optionalString,
  OPENAI_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().default("text-embedding-3-small")),
  OPENAI_TRANSCRIBE_MODEL: z.preprocess(emptyToUndefined, z.string().default("gpt-4o-transcribe")),

  DATABASE_URL: optionalString,
  PGLITE_DIR: z.preprocess(emptyToUndefined, z.string().default(".data/pglite")),

  MASTER_ENCRYPTION_KEY: optionalString,

  EPOCH_MAX_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(24000)),
  EPOCH_IDLE_HOURS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(72)),
  KNOWLEDGE_INLINE_MAX_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(30000)),
  RETENTION_MONTHS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(24)),
  TIMEZONE: z.preprocess(emptyToUndefined, z.string().default("Asia/Jerusalem")),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.string().default("warn")),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/** Loads `.env` from the working directory (if present) and validates the environment. */
export function loadConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  if (!cached) {
    if (existsSync(".env")) process.loadEnvFile(".env");
    cached = envSchema.parse(process.env);
  }
  if (Object.keys(overrides).length === 0) return cached;
  return envSchema.parse({ ...process.env, ...overrides });
}

/** For tests: forget the cached config so the next loadConfig() re-reads process.env. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Models that accept the server-side `fallbacks: "default"` parameter on the Claude API. */
const FALLBACK_CAPABLE_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

export function modelSupportsFallbacks(model: string): boolean {
  return FALLBACK_CAPABLE_MODELS.has(model);
}
