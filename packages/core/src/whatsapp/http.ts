import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { logger } from "../logger";
import { spendCaps } from "../spend";
import { applyStatuses, enqueueInbound } from "./inbox";
import { parseWebhook, verifySignature, verifySubscription } from "./webhook";

// Framework-free webhook handling, shared by the standalone Fastify server and the dashboard's route.

export interface HttpResult {
  status: number;
  body?: string;
}

/** Meta's webhook batches are small; anything bigger is refused before it's buffered or its signature checked. */
export const WEBHOOK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Reads a request body up to `max` bytes. Returns null when it's larger, whether declared (Content-Length) or
 * actual, and stops reading there, so an oversized body never sits in memory.
 */
export async function readBodyWithLimit(req: Request, max = WEBHOOK_MAX_BYTES): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Meta's one-time handshake when the webhook URL is registered. */
export function handleWebhookGet(query: Record<string, unknown>, cfg: AppConfig): HttpResult {
  const challenge = verifySubscription(query, cfg.WHATSAPP_VERIFY_TOKEN);
  return challenge === null ? { status: 403, body: "forbidden" } : { status: 200, body: challenge };
}

/**
 * Verifies the signature over the raw bytes, stores messages and statuses, and only then answers 200.
 * Any thrown error becomes a 500, so Meta redelivers later.
 */
export async function handleWebhookPost(db: Db, cfg: AppConfig, raw: Buffer, signature: string | undefined): Promise<HttpResult> {
  if (!cfg.WHATSAPP_APP_SECRET) {
    logger.error("WHATSAPP_APP_SECRET is not set: rejecting webhook (fail closed)");
    return { status: 500 };
  }
  if (!verifySignature(raw, signature, cfg.WHATSAPP_APP_SECRET)) {
    logger.warn("webhook with an invalid signature");
    return { status: 401 };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400 };
  }
  const { messages, statuses } = parseWebhook(body);
  await enqueueInbound(db, messages, {
    debounceMs: cfg.INBOUND_DEBOUNCE_MS,
    clientHourlyLimit: cfg.CLIENT_HOURLY_MESSAGE_LIMIT,
    clientDailyLimit: cfg.CLIENT_DAILY_MESSAGE_LIMIT,
    spendCaps: spendCaps(cfg),
  });
  await applyStatuses(db, statuses);
  return { status: 200 };
}
