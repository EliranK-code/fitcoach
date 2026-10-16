import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import { decryptOptional, encryptOptional } from "../crypto";
import type { Db } from "../db/client";
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
  input: { phoneNumberId: string; displayPhone?: string; wabaId?: string; accessToken?: string; mode?: "managed" | "embedded" },
): Promise<WhatsAppAccount> {
  const existing = await findAccountByPhoneNumberId(db, input.phoneNumberId);
  if (existing && existing.coachId !== t.coachId) {
    throw new WhatsAppConfigError(`Phone number ${input.phoneNumberId} is already connected to another coach`);
  }
  const values = {
    coachId: t.coachId,
    phoneNumberId: input.phoneNumberId,
    displayPhone: input.displayPhone ?? null,
    wabaId: input.wabaId ?? null,
    mode: input.mode ?? (input.accessToken ? "embedded" : "managed"),
    accessTokenEnc: encryptOptional(t, input.accessToken),
    status: "active",
  };
  const [row] = await db
    .insert(whatsappAccounts)
    .values(values)
    .onConflictDoUpdate({ target: whatsappAccounts.phoneNumberId, set: values })
    .returning();
  if (!row) throw new Error("WhatsApp account upsert failed");
  return row;
}

/** Routing lookup for incoming webhooks: which coach owns this number. Deliberately not tenant-scoped. */
export async function findAccountByPhoneNumberId(db: Db, phoneNumberId: string): Promise<WhatsAppAccount | undefined> {
  const [row] = await db.select().from(whatsappAccounts).where(eq(whatsappAccounts.phoneNumberId, phoneNumberId));
  return row?.status === "active" ? row : undefined;
}

export async function getCoachAccount(db: Db, t: TenantContext): Promise<WhatsAppAccount | undefined> {
  const [row] = await db
    .select()
    .from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.coachId, t.coachId), eq(whatsappAccounts.status, "active")))
    .limit(1);
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
