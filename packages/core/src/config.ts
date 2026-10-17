import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

  // WhatsApp Cloud API (stage 2)
  /** System-user token for numbers managed under the platform's Meta account. */
  WHATSAPP_ACCESS_TOKEN: optionalString,
  /** App secret: verifies X-Hub-Signature-256 on every webhook. Without it the webhook rejects everything. */
  WHATSAPP_APP_SECRET: optionalString,
  /** Shared secret Meta echoes when you register the webhook URL. */
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_GRAPH_VERSION: z.preprocess(emptyToUndefined, z.string().default("v23.0")),
  /** Embedded Signup (coaches connect their own number): the Meta app id and the Login for Business configuration id. */
  META_APP_ID: optionalString,
  META_EMBEDDED_SIGNUP_CONFIG_ID: optionalString,
  /** Log outgoing messages instead of calling Meta: lets you run the whole pipeline locally. */
  WHATSAPP_DRY_RUN: z.preprocess((v) => v === "true" || v === "1", z.boolean()),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3000)),
  /** Wait this long after a client's last message before answering, so bursts become one turn. */
  INBOUND_DEBOUNCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(4000)),
  WORKER_CONCURRENCY: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4)),

  // Usage and limits (stage 5)
  /** What Meta charges per template message, for cost estimates (depends on country and category; 0 = unknown). */
  WHATSAPP_TEMPLATE_PRICE_USD: z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().default(0)),
  /** Messages per client per hour the bot answers; beyond it they're kept for the coach. 0 = no limit. */
  CLIENT_HOURLY_MESSAGE_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(30)),
});

export type AppConfig = z.infer<typeof envSchema>;

function isWorkspaceRoot(dir: string): boolean {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return false;
  try {
    return Array.isArray((JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown }).workspaces);
  } catch {
    return false;
  }
}

/**
 * The repository root, where `.env` and `.data/` live. Apps run from their own folders (Next.js runs in
 * apps/dashboard), so we walk up from the working directory instead of trusting it.
 */
export function projectRoot(start = process.cwd()): string {
  // The ignore hints stop Next.js file tracing from bundling the whole repository because of these paths.
  let dir = resolve(/*turbopackIgnore: true*/ start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".env")) || isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(/*turbopackIgnore: true*/ start);
}

let cached: AppConfig | undefined;

function parse(env: Record<string, unknown>): AppConfig {
  const cfg = envSchema.parse(env);
  return { ...cfg, PGLITE_DIR: isAbsolute(cfg.PGLITE_DIR) ? cfg.PGLITE_DIR : resolve(projectRoot(), cfg.PGLITE_DIR) };
}

/** Loads the project's `.env` (if present) and validates the environment. */
export function loadConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  if (!cached) {
    const envFile = join(projectRoot(), ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    cached = parse(process.env);
  }
  if (Object.keys(overrides).length === 0) return cached;
  return parse({ ...process.env, ...overrides });
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
