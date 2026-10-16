import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** Transactions already scoped to a coach, so nested repository calls run in them instead of opening another. */
const scopedTo = new WeakMap<object, string>();

export class TenantScopeError extends Error {}

/**
 * Runs `fn` in a short transaction as the `app_tenant` role with `app.coach_id` set, so row-level security
 * (migration 0005) limits every statement to this coach's rows even if a query forgets its coach_id filter.
 * Repositories wrap their bodies in this; callers never hold a scope across an LLM or Graph API call.
 * A call nested inside a scope for the same coach runs in it directly.
 */
export async function withTenant<T>(db: Db, t: { coachId: string }, fn: (db: Db) => Promise<T>): Promise<T> {
  const current = scopedTo.get(db);
  if (current === t.coachId) return fn(db);
  if (current) throw new TenantScopeError("Nested tenant scope for a different coach");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'app_tenant', true), set_config('app.coach_id', ${t.coachId}, true)`);
    const scoped = tx as unknown as Db;
    scopedTo.set(scoped, t.coachId);
    return fn(scoped);
  });
}
