import { headers } from "next/headers";
import { clientIp, hitRateLimit } from "@fitcoach/core";
import { services } from "./services";

// Per-IP throttle on top of the per-account lockout. Counted in the database (rate_limits), so it holds
// across several dashboard instances.
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;

/** Counts one attempt (login, code, link) from the caller's IP; true once the IP is over the limit. */
export async function throttled(scope: string): Promise<boolean> {
  const h = await headers();
  const { handle, cfg } = await services();
  const ip = clientIp((name) => h.get(name), cfg.TRUSTED_IP_HEADER);
  return (await hitRateLimit(handle.db, `ip:${scope}:${ip}`, IP_WINDOW_MS)) > IP_LIMIT;
}

export const THROTTLED = "Too many attempts. Try again in a few minutes.";
