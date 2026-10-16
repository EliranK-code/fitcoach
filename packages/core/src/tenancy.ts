import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newDataKey, unwrapDataKey, wrapDataKey, type CipherScope } from "./crypto";
import type { Db } from "./db/client";
import { coaches, type CoachSettings } from "./db/schema";

/**
 * Every data access in the system goes through a TenantContext. Repositories take it as a required
 * argument and filter every query by `coachId`, so one coach's data cannot be read through another's context.
 */
export interface TenantContext extends CipherScope {
  coachId: string;
  coachName: string;
  settings: CoachSettings;
  knowledgeVersion: number;
}

export class TenantNotFoundError extends Error {}

const dekCache = new Map<string, Buffer>();

export async function createCoach(
  db: Db,
  input: { slug: string; name: string; settings?: CoachSettings },
): Promise<string> {
  const id = randomUUID();
  const wrappedDek = wrapDataKey(newDataKey(), id);
  await db.insert(coaches).values({
    id,
    slug: input.slug,
    name: input.name,
    settings: input.settings ?? {},
    wrappedDek,
  });
  return id;
}

async function toContext(row: typeof coaches.$inferSelect): Promise<TenantContext> {
  let dek = dekCache.get(row.id);
  if (!dek) {
    dek = unwrapDataKey(row.wrappedDek, row.id);
    dekCache.set(row.id, dek);
  }
  return {
    coachId: row.id,
    coachName: row.name,
    settings: row.settings,
    knowledgeVersion: row.knowledgeVersion,
    dek,
  };
}

export async function openTenant(db: Db, coachId: string): Promise<TenantContext> {
  const [row] = await db.select().from(coaches).where(eq(coaches.id, coachId));
  if (!row || row.status !== "active") throw new TenantNotFoundError(`Coach ${coachId} not found`);
  return toContext(row);
}

export async function openTenantBySlug(db: Db, slug: string): Promise<TenantContext> {
  const [row] = await db.select().from(coaches).where(eq(coaches.slug, slug));
  if (!row || row.status !== "active") throw new TenantNotFoundError(`Coach "${slug}" not found`);
  return toContext(row);
}

/** Updates the coach's display name and/or merges settings (undefined values remove a setting). */
export async function updateCoach(
  db: Db,
  t: TenantContext,
  patch: { name?: string; settings?: Partial<CoachSettings> },
): Promise<TenantContext> {
  const settings: CoachSettings = { ...t.settings, ...patch.settings };
  for (const key of Object.keys(settings) as (keyof CoachSettings)[]) {
    if (settings[key] === undefined) delete settings[key];
  }
  await db
    .update(coaches)
    .set({ ...(patch.name ? { name: patch.name } : {}), settings, updatedAt: new Date() })
    .where(eq(coaches.id, t.coachId));
  return openTenant(db, t.coachId);
}

/** Re-reads mutable coach fields (knowledge version, settings) into a fresh context. */
export async function refreshTenant(db: Db, tenant: TenantContext): Promise<TenantContext> {
  return openTenant(db, tenant.coachId);
}

export function forgetTenantKeys(): void {
  dekCache.clear();
}
