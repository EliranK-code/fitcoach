import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../logger";

/**
 * Meta signs every webhook body with the app secret: `X-Hub-Signature-256: sha256=<hex>`.
 * The HMAC must be computed over the exact raw bytes, before any JSON parsing.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Answers Meta's subscription handshake. Returns the challenge to echo, or null to refuse. */
export function verifySubscription(query: Record<string, unknown>, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

export const INBOUND_KINDS = [
  "text",
  "button",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
  "reaction",
  "unsupported",
] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

export interface InboundWaMessage {
  phoneNumberId: string;
  /** Client's WhatsApp id: their phone number with country code, digits only. */
  from: string;
  id: string;
  timestamp: Date;
  kind: InboundKind;
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mimeType?: string;
}

export interface StatusUpdate {
  phoneNumberId: string;
  messageId: string;
  status: string;
  recipient: string;
  timestamp: Date;
  errorCode?: number;
  errorTitle?: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function toDate(ts: unknown): Date {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

function parseMessage(phoneNumberId: string, m: Json): InboundWaMessage | null {
  const from = str(m.from);
  const id = str(m.id);
  const type = str(m.type);
  if (!from || !id || !type) return null;
  const base = { phoneNumberId, from, id, timestamp: toDate(m.timestamp) };

  switch (type) {
    case "text":
      return { ...base, kind: "text", text: str(isObj(m.text) ? m.text.body : undefined) ?? "" };
    case "interactive": {
      const i = isObj(m.interactive) ? m.interactive : {};
      const reply = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : null;
      if (!reply) return { ...base, kind: "unsupported" };
      return { ...base, kind: "button", buttonId: str(reply.id), text: str(reply.title) ?? "" };
    }
    case "button": {
      // Quick-reply button on a template message.
      const b = isObj(m.button) ? m.button : {};
      return { ...base, kind: "button", buttonId: str(b.payload), text: str(b.text) ?? "" };
    }
    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker": {
      const media = isObj(m[type]) ? (m[type] as Json) : {};
      return { ...base, kind: type, mediaId: str(media.id), mimeType: str(media.mime_type), text: str(media.caption) };
    }
    case "location":
    case "contacts":
    case "reaction":
      return { ...base, kind: type };
    default:
      return { ...base, kind: "unsupported" };
  }
}

/** Extracts messages and delivery statuses from a webhook payload, skipping anything malformed. */
export function parseWebhook(body: unknown): { messages: InboundWaMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundWaMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObj(body) || body.object !== "whatsapp_business_account") return { messages, statuses };

  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const value = change.value;
      const phoneNumberId = str(isObj(value.metadata) ? value.metadata.phone_number_id : undefined);
      if (!phoneNumberId) continue;

      for (const m of arr(value.messages)) {
        const parsed = isObj(m) ? parseMessage(phoneNumberId, m) : null;
        if (parsed) messages.push(parsed);
        else logger.warn({ phoneNumberId }, "skipping malformed WhatsApp message");
      }
      for (const s of arr(value.statuses)) {
        if (!isObj(s) || !str(s.id) || !str(s.status)) continue;
        const firstError = arr(s.errors).find(isObj);
        statuses.push({
          phoneNumberId,
          messageId: str(s.id)!,
          status: str(s.status)!,
          recipient: str(s.recipient_id) ?? "",
          timestamp: toDate(s.timestamp),
          errorCode: firstError && typeof firstError.code === "number" ? firstError.code : undefined,
          errorTitle: firstError ? str(firstError.title) : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}
