import { and, asc, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { AppConfig } from "./config";
import type { Db } from "./db/client";
import {
  chatMessages,
  clients,
  coaches,
  coachUsers,
  inboundMessages,
  platformAudit,
  reminders,
  sessions,
  turnJobs,
  usageEvents,
  whatsappAccounts,
} from "./db/schema";
import { coachKnowledgeSchema, type CoachKnowledge } from "./knowledge/schema";
import { publishKnowledge } from "./knowledge/store";
import { nextOccurrence, resolveReminderSettings } from "./reminders/schedule";
import type { ClientRow } from "./repos/clients";
import { createCoach, forgetTenantKey, openTenant, updateCoach, type TenantContext } from "./tenancy";
import { isValidTimeZone } from "./time";

// Platform operations on whole coaches. They run unscoped (as the table owner) on purpose: they act on a
// coach from the outside, and a deleted coach's records must outlive it in platform_audit.

export class CoachLifecycleError extends Error {}

export type CoachRow = typeof coaches.$inferSelect;

export async function findCoachBySlug(db: Db, slug: string): Promise<CoachRow> {
  const [row] = await db.select().from(coaches).where(eq(coaches.slug, slug));
  if (!row) throw new CoachLifecycleError(`No coach "${slug}"`);
  return row;
}

export interface CoachSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  suspendedAt: Date | null;
  createdAt: Date;
  clients: number;
  /** Model tokens (input + output) since the start of the current UTC month. */
  monthTokens: number;
  /** Still on the starter knowledge from the admin panel: no number can be connected yet. */
  starterKnowledge: boolean;
  /** Active WhatsApp numbers. */
  numbers: number;
  /** Estimated cost since the start of the current UTC month, in micro-dollars. */
  monthCostMicros: number;
  /** Soft monthly budget set by an admin, if any. */
  budgetUsd: number | null;
  /** This coach's own hard monthly cap, if an admin set one (otherwise COACH_MONTHLY_CAP_USD applies). */
  capUsd: number | null;
  /** The demo coach from the seed (removed with `npm run demo:remove`). */
  demo: boolean;
}

export async function recordPlatformAction(
  db: Db,
  entry: { actor: string; action: string; coachId?: string; coachSlug?: string; meta?: Record<string, unknown> },
): Promise<void> {
  let coachSlug = entry.coachSlug;
  if (entry.coachId && !coachSlug) {
    // The slug is kept on the record itself, so the log still reads after the coach is deleted.
    [{ slug: coachSlug } = { slug: undefined }] = await db.select({ slug: coaches.slug }).from(coaches).where(eq(coaches.id, entry.coachId));
  }
  await db.insert(platformAudit).values({ ...entry, coachSlug, meta: entry.meta ?? {} });
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Knowledge a coach created from the panel starts with: valid, mostly empty, meant to be filled in the editor. */
export function starterKnowledge(name: string): CoachKnowledge {
  return coachKnowledgeSchema.parse({
    coach: { name },
    tone: { styles: ["warm"] },
    philosophy: "",
    nutrition: { approach: "no_counting", details: "" },
    training: { principles: "" },
    supplements: {},
    alwaysEscalate: ["Prices, payments and packages", "Cancelling or pausing coaching"],
  });
}

/**
 * Creates a coach from the admin panel, with starter knowledge. Until the coach publishes their own
 * knowledge from the editor, no WhatsApp number can be connected, so the bot never answers on a template.
 */
export async function createCoachFromPanel(db: Db, input: { slug: string; name: string; timezone?: string }, actor: string): Promise<string> {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  if (!SLUG.test(slug)) throw new CoachLifecycleError("The slug: lowercase English letters, digits and hyphens, 2 to 40 characters");
  if (!name) throw new CoachLifecycleError("Name is missing");
  if (input.timezone && !isValidTimeZone(input.timezone)) throw new CoachLifecycleError("Unknown time zone");
  const [existing] = await db.select({ id: coaches.id }).from(coaches).where(eq(coaches.slug, slug));
  if (existing) throw new CoachLifecycleError(`A coach with the slug ${slug} already exists`);
  const coachId = await createCoach(db, { slug, name, settings: input.timezone ? { timezone: input.timezone } : {} });
  const t = await openTenant(db, coachId);
  await publishKnowledge(db, t, { data: starterKnowledge(name) }, null);
  await updateCoach(db, t, { settings: { starterKnowledge: true } });
  await recordPlatformAction(db, { actor, action: "coach_created", coachId, coachSlug: slug });
  return coachId;
}

/** What the admin panel shows about one coach's users: no client data, only who can log in. */
export async function listCoachUsersForPanel(db: Db, coachId: string) {
  return db
    .select({
      id: coachUsers.id,
      email: coachUsers.email,
      role: coachUsers.role,
      mfa: sql<boolean>`${coachUsers.totpEnabledAt} is not null`,
      lockedUntil: coachUsers.lockedUntil,
      lastLoginAt: coachUsers.lastLoginAt,
      createdAt: coachUsers.createdAt,
    })
    .from(coachUsers)
    .where(eq(coachUsers.coachId, coachId))
    .orderBy(asc(coachUsers.email));
}

export async function listCoachNumbers(db: Db, coachId: string) {
  return db
    .select({ phoneNumberId: whatsappAccounts.phoneNumberId, displayPhone: whatsappAccounts.displayPhone, mode: whatsappAccounts.mode, status: whatsappAccounts.status })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.coachId, coachId));
}

export async function listCoaches(db: Db, now = new Date()): Promise<CoachSummary[]> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return db
    .select({
      id: coaches.id,
      slug: coaches.slug,
      name: coaches.name,
      status: coaches.status,
      suspendedAt: coaches.suspendedAt,
      createdAt: coaches.createdAt,
      // Written out with aliases: drizzle renders columns unqualified here, and "id" would bind to the inner table.
      clients: sql<number>`(select count(*)::int from clients c where c.coach_id = coaches.id and not c.is_test)`,
      monthTokens: sql<number>`(select coalesce(sum(u.input_tokens + u.output_tokens), 0)::int from usage_events u
        where u.coach_id = coaches.id and u.created_at >= ${monthStart.toISOString()}::timestamptz)`,
      starterKnowledge: sql<boolean>`coalesce((coaches.settings->>'starterKnowledge')::boolean, false)`,
      numbers: sql<number>`(select count(*)::int from whatsapp_accounts w where w.coach_id = coaches.id and w.status = 'active')`,
      monthCostMicros: sql<number>`(select coalesce(sum(u.cost_micros), 0)::bigint from usage_events u
        where u.coach_id = coaches.id and u.created_at >= ${monthStart.toISOString()}::timestamptz)`.mapWith(Number),
      budgetUsd: sql<number | null>`(coaches.settings->>'monthlyBudgetUsd')::float8`,
      capUsd: sql<number | null>`(coaches.settings->>'monthlyCapUsd')::float8`,
      demo: sql<boolean>`coalesce((coaches.settings->>'demo')::boolean, false)`,
    })
    .from(coaches)
    .orderBy(asc(coaches.slug));
}

/**
 * Suspends a coach: the bot stops answering (clients get one fixed notice), logins and sessions end,
 * queued turns are cancelled and reminders pause. Data stays as is. Returns false if already suspended.
 */
export async function suspendCoach(db: Db, coachId: string, actor: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(coaches).where(eq(coaches.id, coachId)).for("update");
    if (!row) throw new CoachLifecycleError(`Coach ${coachId} not found`);
    if (row.status === "suspended") return false;
    await tx.update(coaches).set({ status: "suspended", suspendedAt: now, updatedAt: now }).where(eq(coaches.id, coachId));
    await tx.delete(sessions).where(eq(sessions.coachId, coachId));
    await tx.delete(turnJobs).where(eq(turnJobs.coachId, coachId));
    await tx
      .update(inboundMessages)
      .set({ status: "failed", bodyEnc: null })
      .where(and(eq(inboundMessages.coachId, coachId), eq(inboundMessages.status, "pending")));
    await tx.insert(platformAudit).values({ actor, action: "coach_suspended", coachId, coachSlug: row.slug });
    return true;
  });
}

/**
 * Reactivates a suspended coach. Reminders continue from their next occurrence after now, so a long
 * suspension doesn't release a burst of overdue reminders. Returns false if the coach wasn't suspended.
 */
export async function resumeCoach(db: Db, coachId: string, actor: string, cfg: Pick<AppConfig, "TIMEZONE">, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(coaches).where(eq(coaches.id, coachId)).for("update");
    if (!row) throw new CoachLifecycleError(`Coach ${coachId} not found`);
    if (row.status !== "suspended") return false;
    await tx.update(coaches).set({ status: "active", suspendedAt: null, updatedAt: now }).where(eq(coaches.id, coachId));
    const tz = row.settings.timezone ?? cfg.TIMEZONE;
    const settings = resolveReminderSettings(row.settings.reminders);
    const due = await tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.coachId, coachId), eq(reminders.enabled, true), isNotNull(reminders.nextRunAt)));
    for (const r of due) {
      await tx.update(reminders).set({ nextRunAt: nextOccurrence(r, now, tz, settings) }).where(eq(reminders.id, r.id));
    }
    await tx.insert(platformAudit).values({ actor, action: "coach_resumed", coachId, coachSlug: row.slug });
    return true;
  });
}

export interface DeletionSummary {
  slug: string;
  name: string;
  createdAt: string;
  suspendedAt: string | null;
  clients: number;
  /** Per UTC month, for billing after the coach is gone. */
  usage: {
    month: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** WhatsApp messages (in, out and templates). */
    quantity: number;
    costMicros: number;
  }[];
  messages: { month: string; direction: string; count: number }[];
}

const month = (col: typeof usageEvents.createdAt | typeof chatMessages.createdAt) =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM')`;

/**
 * Permanently deletes a coach and everything under them. Only a suspended coach can be deleted, and the
 * caller must repeat the slug. In one transaction: a deletion record with the usage summary goes to
 * platform_audit, then the coach row is deleted and every table cascades, including the wrapped data key.
 * Copies of encrypted data outside the database can't be decrypted without that key; database backups
 * still hold it until they expire.
 */
export async function deleteCoach(db: Db, coachId: string, opts: { actor: string; confirmSlug: string }): Promise<DeletionSummary> {
  const summary = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(coaches).where(eq(coaches.id, coachId)).for("update");
    if (!row) throw new CoachLifecycleError(`Coach ${coachId} not found`);
    if (row.status !== "suspended") throw new CoachLifecycleError(`Suspend coach ${row.slug} before deleting it`);
    if (opts.confirmSlug !== row.slug) throw new CoachLifecycleError(`The confirmation doesn't match: type ${row.slug}`);

    const [clientCount] = await tx.select({ n: count() }).from(clients).where(and(eq(clients.coachId, coachId), eq(clients.isTest, false)));
    const usage = await tx
      .select({
        month: month(usageEvents.createdAt),
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)::int`,
        cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)::int`,
        quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`.mapWith(Number),
      })
      .from(usageEvents)
      .where(eq(usageEvents.coachId, coachId))
      .groupBy(month(usageEvents.createdAt))
      .orderBy(month(usageEvents.createdAt));
    const messages = await tx
      .select({ month: month(chatMessages.createdAt), direction: chatMessages.direction, count: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(eq(chatMessages.coachId, coachId))
      .groupBy(month(chatMessages.createdAt), chatMessages.direction)
      .orderBy(month(chatMessages.createdAt), chatMessages.direction);

    const result: DeletionSummary = {
      slug: row.slug,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      clients: clientCount?.n ?? 0,
      usage,
      messages,
    };
    await tx.insert(platformAudit).values({ actor: opts.actor, action: "coach_deleted", coachId, coachSlug: row.slug, meta: result });
    await tx.delete(coaches).where(eq(coaches.id, coachId));
    return result;
  });
  forgetTenantKey(coachId);
  return summary;
}

export async function listPlatformAudit(db: Db, opts: { since?: Date; limit?: number } = {}) {
  return db
    .select()
    .from(platformAudit)
    .where(opts.since ? gte(platformAudit.createdAt, opts.since) : undefined)
    .orderBy(sql`${platformAudit.createdAt} desc`)
    .limit(opts.limit ?? 100);
}

/** The fixed reply a suspended coach's clients get: no AI, nothing about them is stored. */
export function suspendedNoticeText(coachName: string): string {
  return `${coachName}'s WhatsApp service isn't available right now. You can contact ${coachName} directly.`;
}

/** True if this client should still get the notice in the current suspension. */
export function suspensionNoticeDue(t: TenantContext, client: ClientRow): boolean {
  if (t.status !== "suspended" || !t.suspendedAt) return false;
  const sent = client.flags.suspensionNoticeAt ? Date.parse(client.flags.suspensionNoticeAt) : 0;
  return sent < t.suspendedAt.getTime();
}

/** Coaches marked as demo (`settings.demo`, set by `npm run seed`). Platform path. */
export async function listDemoCoaches(db: Db): Promise<{ id: string; slug: string; name: string; status: string }[]> {
  return db
    .select({ id: coaches.id, slug: coaches.slug, name: coaches.name, status: coaches.status })
    .from(coaches)
    .where(sql`coalesce((${coaches.settings}->>'demo')::boolean, false)`)
    .orderBy(asc(coaches.slug));
}

/**
 * Deletes every demo coach, with all their clients and data, the same way an admin deletes a coach
 * (suspend, then delete; the usage summary stays in platform_audit). Real coaches are never touched.
 */
export async function removeDemoCoaches(db: Db, actor: string, now = new Date()): Promise<DeletionSummary[]> {
  const removed: DeletionSummary[] = [];
  for (const coach of await listDemoCoaches(db)) {
    if (coach.status !== "suspended") await suspendCoach(db, coach.id, actor, now);
    removed.push(await deleteCoach(db, coach.id, { actor, confirmSlug: coach.slug }));
  }
  return removed;
}
