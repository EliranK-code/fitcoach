import { gte, sql } from "drizzle-orm";
import type { AppConfig } from "./config";
import type { Db } from "./db/client";
import { usageEvents } from "./db/schema";
import type { TenantContext } from "./tenancy";
import { monthUsage } from "./usage";

// Hard spending caps. Unlike the soft budget (banners only), reaching a cap stops new AI work: inbound
// messages are kept for the coach instead of being answered, and the playground refuses. Work already
// queued still finishes, so a cap can be passed by a few turns.

export interface SpendCaps {
  /** Monthly cap for a coach without one of their own, in USD; 0 = none. */
  coachMonthlyUsd: number;
  /** Cap on the whole platform per UTC day, in USD; 0 = none. */
  platformDailyUsd: number;
}

export const spendCaps = (cfg: AppConfig): SpendCaps => ({
  coachMonthlyUsd: cfg.COACH_MONTHLY_CAP_USD,
  platformDailyUsd: cfg.PLATFORM_DAILY_CAP_USD,
});

/** The cap that applies to this coach: their own (set by an admin) or the platform default. null = no cap. */
export function coachCapUsd(t: Pick<TenantContext, "settings">, caps: SpendCaps): number | null {
  const cap = t.settings.monthlyCapUsd ?? caps.coachMonthlyUsd;
  return cap > 0 ? cap : null;
}

export const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Everything spent on the platform since the start of the UTC day. Platform path: never call it inside a tenant scope. */
export async function platformDaySpendMicros(db: Db, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ micros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint` })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, dayStart(now)));
  return Number(row?.micros ?? 0);
}

export interface SpendBlock {
  scope: "coach" | "platform";
  capUsd: number;
  spentMicros: number;
}

/** Why this coach's bot must not start new AI work right now, or null when it may. */
export async function spendBlock(db: Db, t: TenantContext, caps: SpendCaps, now = new Date()): Promise<SpendBlock | null> {
  const coachCap = coachCapUsd(t, caps);
  if (coachCap !== null) {
    const spent = (await monthUsage(db, t, now)).costMicros;
    if (spent >= coachCap * 1_000_000) return { scope: "coach", capUsd: coachCap, spentMicros: spent };
  }
  if (caps.platformDailyUsd > 0) {
    const spent = await platformDaySpendMicros(db, now);
    if (spent >= caps.platformDailyUsd * 1_000_000) return { scope: "platform", capUsd: caps.platformDailyUsd, spentMicros: spent };
  }
  return null;
}

/** What the coach is told when a cap stops the bot (alert, playground, dashboard). */
export function spendBlockMessage(block: SpendBlock): string {
  return block.scope === "coach"
    ? `הגעתם לתקרת ההוצאה החודשית ($${block.capUsd}). הבוט לא עונה ללקוחות עד תחילת החודש הבא או עד שמנהל המערכת יעלה את התקרה. ההודעות של הלקוחות נשמרות בשיחה.`
    : "הבוט מושהה זמנית: הפלטפורמה הגיעה לתקרת ההוצאה היומית. ההודעות של הלקוחות נשמרות בשיחה, והבוט יחזור לענות מחר (לפי שעון UTC) או כשמנהל המערכת יעלה את התקרה.";
}
