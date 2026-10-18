import { normalizePhone } from "./crypto";
import type { Db } from "./db/client";
import type { ClientAccessMode, CoachSettings } from "./db/schema";
import { findOrCreateClient, requireClient, setClientFlags, updateClient, type ClientRow } from "./repos/clients";
import { audit, listAlerts, resolveAlert } from "./repos/ops";
import type { TenantContext } from "./tenancy";

// Who may talk to the bot. In "approved only" mode (the default) the bot answers on WhatsApp only numbers the
// coach approved: added in the dashboard, or a join request the coach accepted. Anyone else gets one short
// notice a day and the coach gets a join request; nothing they write reaches the AI or is stored. In "open"
// mode a new number is approved on its first message. Terminal and playground clients are always approved.

export class ClientAccessError extends Error {}

export const clientAccessMode = (settings: CoachSettings): ClientAccessMode => settings.clientAccess ?? "approved_only";

/** An unapproved number gets the notice at most this often. */
export const ACCESS_NOTICE_INTERVAL_MS = 24 * 3600_000;

export function accessNoticeText(coachName: string): string {
  return `שלום! המספר הזה משמש את הלקוחות של ${coachName}. העברתי את הפנייה שלך, ונחזור אליך בהקדם 🙂`;
}

export function joinRequestSummary(): string {
  return "מספר שעוד לא אושר כתב לבוט. הבוט לא עונה לו ולא שומר את מה שכתב. אם זה לקוח/ה שלך, אשרו בעמוד הלקוח, והבוט ישלח מיד את הודעת ההסכמה.";
}

/** A phone number the coach typed, in the international form WhatsApp uses (972…), or an error. */
export function parseClientPhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!/^\d{9,15}$/.test(phone)) throw new ClientAccessError("מספר טלפון לא תקין. אפשר לכתוב 050-1234567 או ‎+972501234567");
  return phone;
}

/** The coach approves a number: a join request, a client whose access was removed, or a new number they add. */
export async function approveClient(db: Db, t: TenantContext, client: ClientRow, actor: string, now = new Date()): Promise<ClientRow> {
  let row = client;
  if (!row.approvedAt) row = await updateClient(db, t, row.id, { approvedAt: now });
  row = await setClientFlags(db, t, row, { accessRevokedAt: undefined, accessNoticeAt: undefined });
  for (const alert of await listAlerts(db, t, { clientId: row.id, status: "open" })) {
    if (alert.type === "join_request") await resolveAlert(db, t, alert.id, "אושר");
  }
  await audit(db, t, { actor, action: "client_approved", targetType: "client", targetId: row.id });
  return row;
}

/** Adds a WhatsApp number the coach approves in advance (or approves it, if it already wrote). */
export async function addApprovedClient(db: Db, t: TenantContext, rawPhone: string, actor: string): Promise<{ client: ClientRow; created: boolean }> {
  const phone = parseClientPhone(rawPhone);
  const { client, created } = await findOrCreateClient(db, t, { phone, channel: "whatsapp", approved: true });
  if (created) {
    await audit(db, t, { actor, action: "client_added", targetType: "client", targetId: client.id });
    return { client, created };
  }
  if (client.channel !== "whatsapp") throw new ClientAccessError("המזהה הזה שייך ללקוח שלא בוואטסאפ");
  return { client: client.approvedAt ? client : await approveClient(db, t, client, actor), created: false };
}

/** The coach removes a client's access: the bot stops answering them (they get the notice instead). Data stays. */
export async function revokeClientAccess(db: Db, t: TenantContext, clientId: string, actor: string, now = new Date()): Promise<ClientRow> {
  const client = await requireClient(db, t, clientId);
  let row = await updateClient(db, t, client.id, { approvedAt: null });
  row = await setClientFlags(db, t, row, { accessRevokedAt: now.toISOString() });
  await audit(db, t, { actor, action: "client_access_revoked", targetType: "client", targetId: row.id });
  return row;
}
