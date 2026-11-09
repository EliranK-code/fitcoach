import { pino, type DestinationStream, type LevelWithSilentOrString } from "pino";
import { loadConfig } from "./config";

// Never log message bodies, phone numbers, profiles, emails, tokens or passwords. A field is censored at any
// depth when its name is in this list (case-insensitive) or ends with one of the suffixes below, which covers
// the database's `*Enc` ciphertexts and `*Hash` columns too. A new sensitive field goes here.
const REDACTED_KEYS = new Set([
  // message content
  "text",
  "body",
  "content",
  "caption",
  "transcript",
  "summary",
  "profile",
  "question",
  "answer",
  // contact details
  "phone",
  "to",
  "from",
  "wa_id",
  "waid",
  "email",
  // credentials
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "set-cookie",
  "pin",
  // query parameters (Drizzle puts them on failed-query errors)
  "params",
]);
const REDACTED_SUFFIXES = ["enc", "hash", "token", "secret", "password", "apikey", "phone", "email"];
const CENSOR = "[redacted]";
const MAX_DEPTH = 6;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACTED_KEYS.has(k) || REDACTED_SUFFIXES.some((s) => k.endsWith(s));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A redacted copy of plain objects and arrays. Class instances (errors, requests) go to their serializers. */
export function redactFields(value: unknown, depth = 0): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = isSensitiveKey(k) && v !== undefined ? CENSOR : redactFields(v, depth + 1);
  return out;
}

/** Drizzle writes every query parameter into a failed query's message (and so its stack): `params: ...`. */
function queryParamTexts(err: unknown): string[] {
  const found: string[] = [];
  for (let e = err, i = 0; e instanceof Error && i < 10; e = e.cause, i++) {
    if ("params" in e && "query" in e && e.message.startsWith("Failed query: ")) found.push(`params: ${String(e.params)}`);
  }
  return found;
}

/** pino's error serializer, minus query parameters and fields with sensitive names. */
export function serializeError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as unknown;
  if (out === null || typeof out !== "object") return out;
  const fields = out as Record<string, unknown>;
  const leaks = queryParamTexts(err);
  for (const key of ["message", "stack"]) {
    const original = fields[key];
    if (typeof original !== "string") continue;
    fields[key] = leaks.reduce((s, leak) => s.split(leak).join(`params: ${CENSOR}`), original);
  }
  for (const key of Object.keys(fields)) {
    if (key === "message" || key === "stack" || key === "type") continue;
    fields[key] = isSensitiveKey(key) ? CENSOR : redactFields(fields[key], 1);
  }
  return out;
}

/** The app logger. Tests pass their own destination and level to read what would be written. */
export function createLogger(destination?: DestinationStream, level: LevelWithSilentOrString = loadConfig().LOG_LEVEL) {
  return pino(
    {
      level,
      formatters: { log: (obj) => redactFields(obj) as Record<string, unknown> },
      serializers: { err: serializeError },
    },
    destination,
  );
}

export const logger = createLogger();
