import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newDataKey, unwrapDataKey, wrapDataKey, type CipherScope } from "./crypto";
import type { Db } from "./db/client";
import { withTenant } from "./db/scope";
import { coaches, type CoachSettings } from "./db/schema";

/**
 * Every data access in the system goes through a TenantContext. Repositories take it as a required
 * argument and filter every query by `coachId`, so one coach's data cannot be read through another's context.
 * They also run under row-level security for that coach (db/scope.ts), which catches a missing filter.
 */
export interface TenantContext extends CipherScope {
  coachId: string;
  coachName: string;
  settings: CoachSettings;
  knowledgeVersion: number;
  status: "active" | "suspended";
  suspendedAt: Date | null;
}

export class TenantNotFoundError extends Error {}
/** The coach exists but is suspended: no logins, no AI. Only platform paths open it (allowSuspended). */
export class CoachSuspendedError extends TenantNotFoundError {}

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
    status: row.status === "suspended" ? "suspended" : "active",
    suspendedAt: row.suspendedAt,
    dek,
  };
}

interface OpenOptions {
  /** For platform paths that act on a suspended coach (the "service unavailable" notice). */
  allowSuspended?: boolean;
}

function checkOpen(row: typeof coaches.$inferSelect | undefined, label: string, opts: OpenOptions): typeof coaches.$inferSelect {
  if (!row) throw new TenantNotFoundError(`Coach ${label} not found`);
  if (row.status === "suspended" && !opts.allowSuspended) throw new CoachSuspendedError(`המאמן ${row.slug} מושהה`);
  if (row.status !== "active" && row.status !== "suspended") throw new TenantNotFoundError(`Coach ${label} not found`);
  return row;
}

export async function openTenant(db: Db, coachId: string, opts: OpenOptions = {}): Promise<TenantContext> {
  const [row] = await db.select().from(coaches).where(eq(coaches.id, coachId));
  return toContext(checkOpen(row, coachId, opts));
}

export async function openTenantBySlug(db: Db, slug: string, opts: OpenOptions = {}): Promise<TenantContext> {
  const [row] = await db.select().from(coaches).where(eq(coaches.slug, slug));
  return toContext(checkOpen(row, `"${slug}"`, opts));
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
  await withTenant(db, t, (db) =>
    db
      .update(coaches)
      .set({ ...(patch.name ? { name: patch.name } : {}), settings, updatedAt: new Date() })
      .where(eq(coaches.id, t.coachId)),
  );
  return openTenant(db, t.coachId);
}

/** Re-reads mutable coach fields (knowledge version, settings) into a fresh context. */
export async function refreshTenant(db: Db, tenant: TenantContext): Promise<TenantContext> {
  return openTenant(db, tenant.coachId);
}

export function forgetTenantKeys(): void {
  dekCache.clear();
}

/** Drops one coach's unwrapped key from this process (after the coach is deleted). */
export function forgetTenantKey(coachId: string): void {
  dekCache.delete(coachId);
}
