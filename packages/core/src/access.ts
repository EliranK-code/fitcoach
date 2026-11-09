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
  return `Hi! This number is used by ${coachName}'s clients. I've passed your message on, and we'll get back to you soon 🙂`;
}

export function joinRequestSummary(): string {
  return "A number that isn't approved yet wrote to the bot. The bot doesn't answer it or keep what it wrote. If this is your client, approve them on the client page and the bot will send the consent notice right away.";
}

/**
 * A phone number the coach typed, in the international form WhatsApp uses (digits with the country code), or an
 * error. A local number (leading 0) needs DEFAULT_COUNTRY_CODE; `defaultCountryCode` overrides it ("" = none).
 */
export function parseClientPhone(raw: string, defaultCountryCode?: string): string {
  const phone = normalizePhone(raw, defaultCountryCode);
  if (phone.startsWith("0")) throw new ClientAccessError("Write the number in international form, with the country code, for example +14155550123");
  if (!/^\d{9,15}$/.test(phone)) throw new ClientAccessError("Invalid phone number. Write it in international form, for example +14155550123");
  return phone;
}

/** The coach approves a number: a join request, a client whose access was removed, or a new number they add. */
export async function approveClient(db: Db, t: TenantContext, client: ClientRow, actor: string, now = new Date()): Promise<ClientRow> {
  let row = client;
  if (!row.approvedAt) row = await updateClient(db, t, row.id, { approvedAt: now });
  row = await setClientFlags(db, t, row, { accessRevokedAt: undefined, accessNoticeAt: undefined });
  for (const alert of await listAlerts(db, t, { clientId: row.id, status: "open" })) {
    if (alert.type === "join_request") await resolveAlert(db, t, alert.id, "Approved");
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
  if (client.channel !== "whatsapp") throw new ClientAccessError("This id belongs to a client who isn't on WhatsApp");
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
