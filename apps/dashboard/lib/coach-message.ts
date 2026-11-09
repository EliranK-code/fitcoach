import {
  audit,
  getCoachAccount,
  logChatMessage,
  OutsideServiceWindowError,
  sendCoachMessage,
  WhatsAppApiError,
  WhatsAppConfigError,
  type ClientRow,
} from "@fitcoach/core";
import type { AppSession } from "./session";

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * The coach writes to a client directly. WhatsApp clients get a real message (24-hour window enforced);
 * terminal and playground clients have no phone, so the message is only recorded. Either way it's marked
 * unseen by the bot, which reads it as part of a record on its next turn.
 */
export async function sendAsCoach(s: AppSession, client: ClientRow, text: string): Promise<SendResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "The message is empty" };
  const { db } = s.handle;

  if (client.channel !== "whatsapp") {
    await logChatMessage(db, s.t, { clientId: client.id, direction: "out", sender: "coach", body, botSeen: false });
    await audit(db, s.t, { actor: s.actor, action: "coach_message_logged", targetType: "client", targetId: client.id });
    return { ok: true };
  }

  const account = await getCoachAccount(db, s.t);
  if (!account) return { ok: false, error: "No WhatsApp number is connected. Connect one on the Settings page." };
  try {
    const api = await s.whatsappApi(s.t, account.phoneNumberId);
    await sendCoachMessage(db, s.t, client, api, body, { now: new Date(), actor: s.actor });
    return { ok: true };
  } catch (err) {
    if (err instanceof OutsideServiceWindowError || err instanceof WhatsAppConfigError) return { ok: false, error: err.message };
    if (err instanceof WhatsAppApiError) return { ok: false, error: `WhatsApp rejected the message: ${err.message}` };
    throw err;
  }
}
