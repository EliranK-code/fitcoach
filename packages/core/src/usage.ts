import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { withTenant } from "./db/scope";
import { usageEvents } from "./db/schema";

export interface MonthUsage {
  /** Start of the UTC month. */
  since: Date;
  costMicros: number;
  /** Model tokens, input + output. */
  tokens: number;
  messagesIn: number;
  messagesOut: number;
  templates: number;
  byKind: { kind: string; events: number; quantity: number; tokens: number; costMicros: number }[];
}

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** One coach's usage since the start of the current UTC month, read in that coach's tenant scope. */
export async function monthUsage(db: Db, coach: { coachId: string }, now = new Date()): Promise<MonthUsage> {
  const since = monthStart(now);
  const rows = await withTenant(db, coach, (db) =>
    db
      .select({
        kind: usageEvents.kind,
        events: sql<number>`count(*)::int`,
        quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
        tokens: sql<number>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.coachId, coach.coachId), gte(usageEvents.createdAt, since)))
      .groupBy(usageEvents.kind),
  );
  const byKind = rows.map((r) => ({ ...r, costMicros: Number(r.costMicros) }));
  const sum = (pick: (r: (typeof byKind)[number]) => number) => byKind.reduce((s, r) => s + pick(r), 0);
  const qty = (kind: string) => byKind.find((r) => r.kind === kind)?.quantity ?? 0;
  return {
    since,
    costMicros: sum((r) => r.costMicros),
    tokens: sum((r) => r.tokens),
    messagesIn: qty("message_in"),
    messagesOut: qty("message_out"),
    templates: qty("template"),
    byKind: byKind.sort((a, b) => b.costMicros - a.costMicros || b.events - a.events),
  };
}
