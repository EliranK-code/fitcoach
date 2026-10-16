import { and, desc, eq } from "drizzle-orm";
import { decryptJson, decryptText, encryptJson, encryptText, phoneHash } from "../crypto";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { clientMemory, clientProfiles, clients, type ClientFlags } from "../db/schema";
import type { ClientProfile } from "../profile";
import type { TenantContext } from "../tenancy";

export type ClientRow = typeof clients.$inferSelect;

export async function findClientByPhone(db: Db, t: TenantContext, phone: string): Promise<ClientRow | undefined> {
  return withTenant(db, t, async (db) => {
    const [row] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.coachId, t.coachId), eq(clients.phoneHash, phoneHash(t.coachId, phone))));
    return row;
  });
}

export async function findOrCreateClient(
  db: Db,
  t: TenantContext,
  input: { phone: string; channel: string; isTest?: boolean },
): Promise<{ client: ClientRow; created: boolean }> {
  return withTenant(db, t, async (db) => {
    const existing = await findClientByPhone(db, t, input.phone);
    if (existing) return { client: existing, created: false };
    const [row] = await db
      .insert(clients)
      .values({
        coachId: t.coachId,
        phoneHash: phoneHash(t.coachId, input.phone),
        phoneEnc: encryptText(t, input.phone),
        channel: input.channel,
        isTest: input.isTest ?? false,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { client: row, created: true };
    // Lost a race with a concurrent insert for the same phone.
    const again = await findClientByPhone(db, t, input.phone);
    if (!again) throw new Error("Client insert failed");
    return { client: again, created: false };
  });
}

export async function getClient(db: Db, t: TenantContext, clientId: string): Promise<ClientRow | undefined> {
  return withTenant(db, t, async (db) => {
    const [row] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.coachId, t.coachId), eq(clients.id, clientId)));
    return row;
  });
}

export async function requireClient(db: Db, t: TenantContext, clientId: string): Promise<ClientRow> {
  const row = await getClient(db, t, clientId);
  if (!row) throw new Error(`Client ${clientId} not found for this coach`);
  return row;
}

export async function listClients(db: Db, t: TenantContext): Promise<ClientRow[]> {
  return withTenant(db, t, (db) =>
    db.select().from(clients).where(eq(clients.coachId, t.coachId)).orderBy(desc(clients.createdAt)),
  );
}

export function clientPhone(t: TenantContext, client: ClientRow): string {
  return decryptText(t, client.phoneEnc);
}

export async function updateClient(
  db: Db,
  t: TenantContext,
  clientId: string,
  patch: Partial<
    Pick<
      ClientRow,
      "consentStatus" | "consentAt" | "consentVersion" | "botPaused" | "pausedAt" | "lastInboundAt" | "flags"
    >
  >,
): Promise<ClientRow> {
  const [row] = await withTenant(db, t, (db) =>
    db
      .update(clients)
      .set(patch)
      .where(and(eq(clients.coachId, t.coachId), eq(clients.id, clientId)))
      .returning(),
  );
  if (!row) throw new Error(`Client ${clientId} not found for this coach`);
  return row;
}

export async function setClientFlags(
  db: Db,
  t: TenantContext,
  client: ClientRow,
  patch: Partial<ClientFlags>,
): Promise<ClientRow> {
  const flags: ClientFlags = { ...client.flags, ...patch };
  for (const key of Object.keys(flags) as (keyof ClientFlags)[]) {
    if (flags[key] === undefined) delete flags[key];
  }
  return updateClient(db, t, client.id, { flags });
}

export async function getProfile(db: Db, t: TenantContext, clientId: string): Promise<ClientProfile> {
  const [row] = await withTenant(db, t, (db) =>
    db
      .select()
      .from(clientProfiles)
      .where(and(eq(clientProfiles.coachId, t.coachId), eq(clientProfiles.clientId, clientId))),
  );
  return row ? decryptJson<ClientProfile>(t, row.dataEnc) : {};
}

export async function saveProfile(db: Db, t: TenantContext, clientId: string, profile: ClientProfile): Promise<void> {
  const dataEnc = encryptJson(t, profile);
  await withTenant(db, t, (db) =>
    db
      .insert(clientProfiles)
      .values({ clientId, coachId: t.coachId, dataEnc })
      .onConflictDoUpdate({ target: clientProfiles.clientId, set: { dataEnc, updatedAt: new Date() } }),
  );
}

export interface ClientMemoryData {
  summary: string;
  /** The last few exchanges of the previous epoch, carried over as plain text for continuity. */
  recent: string | null;
  updatedAt: Date;
}

export async function getMemory(db: Db, t: TenantContext, clientId: string): Promise<ClientMemoryData | null> {
  const [row] = await withTenant(db, t, (db) =>
    db
      .select()
      .from(clientMemory)
      .where(and(eq(clientMemory.coachId, t.coachId), eq(clientMemory.clientId, clientId))),
  );
  if (!row) return null;
  return {
    summary: decryptText(t, row.summaryEnc),
    recent: row.recentEnc ? decryptText(t, row.recentEnc) : null,
    updatedAt: row.updatedAt,
  };
}

export async function saveMemory(
  db: Db,
  t: TenantContext,
  clientId: string,
  summary: string,
  recent: string | null,
): Promise<void> {
  const summaryEnc = encryptText(t, summary);
  const recentEnc = recent ? encryptText(t, recent) : null;
  await withTenant(db, t, (db) =>
    db
      .insert(clientMemory)
      .values({ clientId, coachId: t.coachId, summaryEnc, recentEnc })
      .onConflictDoUpdate({ target: clientMemory.clientId, set: { summaryEnc, recentEnc, updatedAt: new Date() } }),
  );
}
