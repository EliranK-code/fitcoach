import { headers } from "next/headers";

// Per-IP throttle on top of the per-account lockout in the database (single-instance memory is enough here).
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;

/** Counts one attempt (login, code, link) from the caller's IP; true once the IP is over the limit. */
export async function throttled(scope: string): Promise<boolean> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const entry = attemptsByIp.get(key);
  if (!entry || entry.resetAt < now) {
    attemptsByIp.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > IP_LIMIT;
}

export const THROTTLED = "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.";
