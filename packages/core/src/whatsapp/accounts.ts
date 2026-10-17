import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import { decryptOptional, encryptOptional } from "../crypto";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { whatsappAccounts } from "../db/schema";
import type { TenantContext } from "../tenancy";
import { createDryRunApi, createGraphApi, type DryRunEntry, type WhatsAppApi } from "./api";

export type WhatsAppAccount = typeof whatsappAccounts.$inferSelect;

export class WhatsAppConfigError extends Error {}

/**
 * Links a WhatsApp phone number to a coach. Managed numbers (under the platform's Meta account) use the
 * platform token from the environment; numbers a coach connects themselves (Embedded Signup, stage 5)
 * store their own token, encrypted with the coach's key.
 */
export async function connectWhatsAppNumber(
  db: Db,
  t: TenantContext,
  input: {
    phoneNumberId: string;
    displayPhone?: string;
    wabaId?: string;
    accessToken?: string;
    mode?: "managed" | "embedded";
    registrationPin?: string;
  },
): Promise<WhatsAppAccount> {
  await assertNumberAvailable(db, t, input.phoneNumberId);
  const values = {
    coachId: t.coachId,
    phoneNumberId: input.phoneNumberId,
    displayPhone: input.displayPhone ?? null,
    wabaId: input.wabaId ?? null,
    mode: input.mode ?? (input.accessToken ? "embedded" : "managed"),
    accessTokenEnc: encryptOptional(t, input.accessToken),
    registrationPinEnc: encryptOptional(t, input.registrationPin),
    status: "active",
  };
  const [row] = await withTenant(db, t, (db) =>
    db
      .insert(whatsappAccounts)
      .values(values)
      .onConflictDoUpdate({ target: whatsappAccounts.phoneNumberId, set: values })
      .returning(),
  );
  if (!row) throw new Error("WhatsApp account upsert failed");
  return row;
}

/**
 * Whether this coach may connect this number: not before they publish their own knowledge, and never a
 * number another coach holds. Checked before Embedded Signup spends Meta's one-time code, and again on save.
 */
export async function assertNumberAvailable(db: Db, t: TenantContext, phoneNumberId: string): Promise<WhatsAppAccount | undefined> {
  if (t.settings.starterKnowledge) {
    throw new WhatsAppConfigError("אי אפשר לחבר מספר לפני שהמאמן ממלא ומפרסם את בסיס הידע שלו");
  }
  // Unscoped on purpose: the number may belong to another coach, including an inactive one.
  const [existing] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.phoneNumberId, phoneNumberId));
  if (existing && existing.coachId !== t.coachId) {
    throw new WhatsAppConfigError("המספר הזה כבר מחובר למאמן אחר");
  }
  return existing;
}

/**
 * Removes a number from its coach (platform action): incoming messages for it are ignored from now on,
 * and its stored token and PIN go with the row, so the number can later be connected to any coach.
 */
export async function disconnectWhatsAppNumber(db: Db, coachId: string, phoneNumberId: string): Promise<WhatsAppAccount | undefined> {
  const [row] = await db
    .delete(whatsappAccounts)
    .where(and(eq(whatsappAccounts.coachId, coachId), eq(whatsappAccounts.phoneNumberId, phoneNumberId)))
    .returning();
  return row;
}

/** Routing lookup for incoming webhooks: which coach owns this number. Deliberately not tenant-scoped. */
export async function findAccountByPhoneNumberId(db: Db, phoneNumberId: string): Promise<WhatsAppAccount | undefined> {
  const [row] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.phoneNumberId, phoneNumberId));
  return row?.status === "active" ? row : undefined;
}

export async function getCoachAccount(db: Db, t: TenantContext): Promise<WhatsAppAccount | undefined> {
  const [row] = await withTenant(db, t, (db) =>
    db
      .select()
      .from(whatsappAccounts)
      .where(and(eq(whatsappAccounts.coachId, t.coachId), eq(whatsappAccounts.status, "active")))
      .limit(1),
  );
  return row;
}

export function createApiForAccount(
  t: TenantContext,
  account: WhatsAppAccount,
  cfg: AppConfig,
  dryRunSink?: (entry: DryRunEntry) => void,
): WhatsAppApi {
  if (account.coachId !== t.coachId) throw new WhatsAppConfigError("Account does not belong to this coach");
  if (cfg.WHATSAPP_DRY_RUN) return createDryRunApi(account.phoneNumberId, dryRunSink);
  const token = decryptOptional(t, account.accessTokenEnc) ?? cfg.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    throw new WhatsAppConfigError("WHATSAPP_ACCESS_TOKEN חסר ב-.env (או הגדירו WHATSAPP_DRY_RUN=true לבדיקה מקומית)");
  }
  return createGraphApi({ token, phoneNumberId: account.phoneNumberId, version: cfg.WHATSAPP_GRAPH_VERSION });
}
