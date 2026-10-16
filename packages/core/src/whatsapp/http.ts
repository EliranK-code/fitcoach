import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { logger } from "../logger";
import { applyStatuses, enqueueInbound } from "./inbox";
import { parseWebhook, verifySignature, verifySubscription } from "./webhook";

// Framework-free webhook handling, shared by the standalone Fastify server and the dashboard's route.

export interface HttpResult {
  status: number;
  body?: string;
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
  await enqueueInbound(db, messages, { debounceMs: cfg.INBOUND_DEBOUNCE_MS });
  await applyStatuses(db, statuses);
  return { status: 200 };
}
