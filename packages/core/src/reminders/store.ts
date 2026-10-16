import { and, asc, eq, inArray, isNotNull, lte, notInArray } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { coaches, reminders, type ReminderKind } from "../db/schema";
import type { TenantContext } from "../tenancy";
import { nextOccurrence, resolveReminderSettings } from "./schedule";

export type ReminderRow = typeof reminders.$inferSelect;

export interface ReminderSpec {
  kind: ReminderKind;
  days: number[];
  time: string;
}

const zoneOf = (t: TenantContext, cfg: Pick<AppConfig, "TIMEZONE">) => t.settings.timezone ?? cfg.TIMEZONE;

/** Replaces the client's reminders with exactly this set (kinds not listed are removed). */
export async function setClientReminders(
  db: Db,
  t: TenantContext,
  cfg: Pick<AppConfig, "TIMEZONE">,
  clientId: string,
  specs: ReminderSpec[],
  now: Date,
): Promise<ReminderRow[]> {
  const settings = resolveReminderSettings(t.settings.reminders);
  const tz = zoneOf(t, cfg);
  const kinds = specs.map((s) => s.kind);
  await withTenant(db, t, async (tx) => {
    const scope = and(eq(reminders.coachId, t.coachId), eq(reminders.clientId, clientId));
    await tx.delete(reminders).where(kinds.length ? and(scope, notInArray(reminders.kind, kinds)) : scope);
    for (const spec of specs) {
      const values = {
        days: [...new Set(spec.days)].sort((a, b) => a - b),
        time: spec.time,
        enabled: true,
        nextRunAt: nextOccurrence(spec, now, tz, settings),
      };
      await tx
        .insert(reminders)
        .values({ coachId: t.coachId, clientId, kind: spec.kind, ...values })
        .onConflictDoUpdate({ target: [reminders.clientId, reminders.kind], set: values });
    }
  });
  return listClientReminders(db, t, clientId);
}

export async function listClientReminders(db: Db, t: TenantContext, clientId: string): Promise<ReminderRow[]> {
  return withTenant(db, t, (db) =>
    db
      .select()
      .from(reminders)
      .where(and(eq(reminders.coachId, t.coachId), eq(reminders.clientId, clientId)))
      .orderBy(asc(reminders.kind)),
  );
}

export async function disableClientReminders(db: Db, t: TenantContext, clientId: string): Promise<void> {
  await withTenant(db, t, (db) =>
    db
      .update(reminders)
      .set({ enabled: false, nextRunAt: null })
      .where(and(eq(reminders.coachId, t.coachId), eq(reminders.clientId, clientId))),
  );
}

/**
 * Claims due reminders and, in the same transaction, moves each to its next occurrence, so a reminder
 * can't be picked twice (SKIP LOCKED also keeps parallel schedulers apart). Platform path: it spans all
 * coaches, so it runs unscoped; sending each reminder is scoped to its coach.
 */
export async function claimDueReminders(db: Db, cfg: Pick<AppConfig, "TIMEZONE">, now: Date, limit = 50): Promise<ReminderRow[]> {
  return db.transaction(async (tx) => {
    // A suspended coach's reminders stay put; resuming moves them to their next occurrence.
    const activeCoaches = tx.select({ id: coaches.id }).from(coaches).where(eq(coaches.status, "active"));
    const due = await tx
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.enabled, true),
          isNotNull(reminders.nextRunAt),
          lte(reminders.nextRunAt, now),
          inArray(reminders.coachId, activeCoaches),
        ),
      )
      .orderBy(asc(reminders.nextRunAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const coachRows = await tx
      .select({ id: coaches.id, settings: coaches.settings })
      .from(coaches)
      .where(inArray(coaches.id, [...new Set(due.map((r) => r.coachId))]));
    const byCoach = new Map(coachRows.map((c) => [c.id, c.settings]));
    for (const r of due) {
      const settings = byCoach.get(r.coachId) ?? {};
      const next = nextOccurrence(r, now, settings.timezone ?? cfg.TIMEZONE, resolveReminderSettings(settings.reminders));
      await tx.update(reminders).set({ nextRunAt: next, lastSentAt: now }).where(eq(reminders.id, r.id));
    }
    return due;
  });
}
