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

/**
 * The caller's IP for per-IP throttling, from request headers. Only what our own proxy wrote can be trusted:
 * `trustedHeader` (TRUSTED_IP_HEADER, e.g. x-real-ip) when set, otherwise the last X-Forwarded-For hop, which
 * the nearest proxy appended. The first hop is whatever the caller sent, so rotating it would dodge the limit.
 */
export function clientIp(header: (name: string) => string | null | undefined, trustedHeader?: string): string {
  const lastHop = (value: string | null | undefined) => value?.split(",").at(-1)?.trim() || null;
  if (trustedHeader) return lastHop(header(trustedHeader)) ?? "unknown";
  return lastHop(header("x-forwarded-for")) ?? "local";
}

/** Housekeeping: counters whose window ended long ago. */
export async function purgeRateLimits(db: Db, olderThan: Date): Promise<number> {
  const rows = await db.delete(rateLimits).where(lt(rateLimits.windowStart, olderThan)).returning({ key: rateLimits.key });
  return rows.length;
}
