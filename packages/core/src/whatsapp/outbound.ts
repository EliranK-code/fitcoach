import type { Db } from "../db/client";
import type { TurnResult } from "../engine/conversation";
import { splitForWhatsApp } from "../format/whatsapp";
import { logger } from "../logger";
import { clientPhone, type ClientRow } from "../repos/clients";
import { logChatMessage, setChatDelivery } from "../repos/conversation";
import { audit, recordMessages } from "../repos/ops";
import type { TenantContext } from "../tenancy";
import { BUTTON_BODY_MAX, WhatsAppApiError, type WhatsAppApi } from "./api";

/** WhatsApp's customer service window: free-form messages only within 24h of the client's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class OutsideServiceWindowError extends Error {
  constructor() {
    super("עברו יותר מ-24 שעות מההודעה האחרונה של הלקוח/ה. מחוץ לחלון אפשר לשלוח רק תבנית (template) מאושרת.");
  }
}

export function serviceWindowOpen(client: ClientRow, now: Date): boolean {
  return client.lastInboundAt !== null && now.getTime() - client.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

/**
 * Sends the bot's replies for one turn. The engine already logged each reply (outboundIds); here each one
 * gets its WhatsApp message id and status. Buttons go on the last reply.
 */
export async function deliverTurn(
  db: Db,
  t: TenantContext,
  client: ClientRow,
  api: WhatsAppApi,
  result: TurnResult,
  now: Date,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let messages = 0; // WhatsApp messages actually sent (a long reply with buttons takes two)
  if (result.replies.length === 0) return { sent, failed };
  if (!serviceWindowOpen(client, now)) {
    // Replies always follow an inbound message, so this only happens if processing was badly delayed.
    logger.warn({ clientId: client.id }, "service window closed before the reply was sent");
  }
  const to = clientPhone(t, client);

  for (let i = 0; i < result.replies.length; i++) {
    const reply = result.replies[i]!;
    const chatId = result.outboundIds[i];
    const isLast = i === result.replies.length - 1;
    try {
      let messageId: string | null;
      if (isLast && result.buttons?.length) {
        if (reply.length <= BUTTON_BODY_MAX) {
          messageId = (await api.sendButtons(to, reply, result.buttons)).messageId;
        } else {
          messageId = (await api.sendText(to, reply)).messageId;
          messages++;
          await api.sendButtons(to, "👇", result.buttons);
        }
      } else {
        messageId = (await api.sendText(to, reply)).messageId;
      }
      messages++;
      if (chatId) await setChatDelivery(db, t, chatId, { externalId: messageId, status: "sent" });
      sent++;
    } catch (err) {
      failed++;
      if (chatId) await setChatDelivery(db, t, chatId, { externalId: null, status: "failed" });
      logger.error(
        { clientId: client.id, code: err instanceof WhatsAppApiError ? err.code : undefined, err },
        "failed to send WhatsApp reply",
      );
    }
  }
  await recordMessages(db, t, client.id, "message_out", messages);
  return { sent, failed };
}

/**
 * A message the coach writes to a client themselves (human takeover). Logged as not yet seen by the bot,
 * so the bot reads it as part of a record on its next turn and stays consistent with what the coach said.
 */
export async function sendCoachMessage(
  db: Db,
  t: TenantContext,
  client: ClientRow,
  api: WhatsAppApi,
  text: string,
  opts: { now: Date; actor: string },
): Promise<number> {
  if (!serviceWindowOpen(client, opts.now)) throw new OutsideServiceWindowError();
  const to = clientPhone(t, client);
  const parts = splitForWhatsApp(text.trim());
  for (const part of parts) {
    const { messageId } = await api.sendText(to, part);
    await logChatMessage(db, t, {
      clientId: client.id,
      direction: "out",
      sender: "coach",
      body: part,
      externalId: messageId ?? undefined,
      status: "sent",
      botSeen: false,
    });
  }
  await recordMessages(db, t, client.id, "message_out", parts.length);
  await audit(db, t, { actor: opts.actor, action: "coach_message_sent", targetType: "client", targetId: client.id });
  return parts.length;
}

/** Sends an approved template: the only way to reach a client after the 24-hour window has closed. */
export async function sendTemplateMessage(
  db: Db,
  t: TenantContext,
  client: ClientRow,
  api: WhatsAppApi,
  template: { name: string; languageCode: string; bodyParams: string[] },
  opts: { actor: string; sender?: "coach" | "system" },
): Promise<void> {
  const { messageId } = await api.sendTemplate(clientPhone(t, client), template.name, template.languageCode, template.bodyParams);
  await logChatMessage(db, t, {
    clientId: client.id,
    direction: "out",
    sender: opts.sender ?? "coach",
    kind: "template",
    body: `[תבנית ${template.name}] ${template.bodyParams.join(" | ")}`.trim(),
    externalId: messageId ?? undefined,
    status: "sent",
    botSeen: false,
  });
  await recordMessages(db, t, client.id, "template");
  await audit(db, t, { actor: opts.actor, action: "template_sent", targetType: "client", targetId: client.id, meta: { template: template.name } });
}
