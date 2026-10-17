import { lt, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { rateLimits } from "./db/schema";

// Fixed-window counters in the database, so limits hold across several server instances (an in-memory
// map only counts what one process sees). Platform path: the table is closed to tenants.

/**
 * Counts one hit for `key` and returns the count in the current window, atomically: concurrent hits get
 * distinct counts. A window older than `windowMs` restarts at 1.
 */
export async function hitRateLimit(db: Db, key: string, windowMs: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when rate_limits.window_start <= ${cutoff}::timestamptz then 1 else rate_limits.count + 1 end`,
        windowStart: sql`case when rate_limits.window_start <= ${cutoff}::timestamptz then ${now.toISOString()}::timestamptz else rate_limits.window_start end`,
      },
    })
    .returning({ count: rateLimits.count });
  return row!.count;
}

/** Housekeeping: counters whose window ended long ago. */
export async function purgeRateLimits(db: Db, olderThan: Date): Promise<number> {
  const rows = await db.delete(rateLimits).where(lt(rateLimits.windowStart, olderThan)).returning({ key: rateLimits.key });
  return rows.length;
}
