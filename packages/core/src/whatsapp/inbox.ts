import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { clientAccessMode } from "../access";
import { decryptJson, encryptJson } from "../crypto";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { inboundMessages, turnJobs } from "../db/schema";
import { logger } from "../logger";
import { suspensionNoticeDue } from "../platform";
import { hitRateLimit } from "../ratelimit";
import { findClientByPhone, findOrCreateClient, updateClient, type ClientRow } from "../repos/clients";
import { applyDeliveryStatus, logChatMessage } from "../repos/conversation";
import { createAlert, recordMessages, type AlertType, type Severity } from "../repos/ops";
import { spendBlock, spendBlockMessage, type SpendCaps } from "../spend";
import { openTenant, TenantNotFoundError, type TenantContext } from "../tenancy";
import { findAccountByPhoneNumberId } from "./accounts";
import type { InboundKind, InboundWaMessage, StatusUpdate } from "./webhook";

// The webhook only stores and acknowledges; the worker does the slow part (Claude). This keeps the webhook
// response fast (Meta retries slow or failing webhooks) and serializes each client's turns.

/** Kinds we never queue: reactions to our own messages need no answer. */
const IGNORED_KINDS: ReadonlySet<InboundKind> = new Set(["reaction"]);

interface StoredBody {
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mimeType?: string;
}

export interface EnqueueStats {
  queued: number;
  duplicates: number;
  ignored: number;
  unknownNumber: number;
  /** Messages to a suspended coach that need no notice (already sent, or not an existing client). */
  suspended: number;
  /** Over the client's hourly or daily limit: kept for the coach, not answered by the bot. */
  rateLimited: number;
  /** The coach's or the platform's spending cap is reached: kept for the coach, not answered. */
  overCap: number;
}

export const CLIENT_RATE_WINDOW_MS = 3600_000;
export const CLIENT_DAY_WINDOW_MS = 24 * 3600_000;

export interface EnqueueOptions {
  debounceMs: number;
  now?: Date;
  /** Messages per client per hour the bot answers; 0 or unset = no limit. */
  clientHourlyLimit?: number;
  /** Messages per client per day the bot answers; 0 or unset = no limit. */
  clientDailyLimit?: number;
  /** Hard spending caps; unset = none. */
  spendCaps?: SpendCaps;
}

export async function enqueueInbound(db: Db, messages: InboundWaMessage[], opts: EnqueueOptions): Promise<EnqueueStats> {
  const stats: EnqueueStats = { queued: 0, duplicates: 0, ignored: 0, unknownNumber: 0, suspended: 0, rateLimited: 0, overCap: 0 };
  const now = opts.now ?? new Date();
  const tenants = new Map<string, TenantContext | null>();

  for (const msg of messages) {
    if (IGNORED_KINDS.has(msg.kind)) {
      stats.ignored++;
      continue;
    }
    const account = await findAccountByPhoneNumberId(db, msg.phoneNumberId);
    let t = account ? tenants.get(account.coachId) : null;
    if (account && t === undefined) {
      // A coach deleted between the lookup and here is just an unknown number: never fail the whole batch.
      t = await openTenant(db, account.coachId, { allowSuspended: true }).catch((err) => {
        if (err instanceof TenantNotFoundError) return null;
        throw err;
      });
      tenants.set(account.coachId, t);
    }
    if (!t) {
      stats.unknownNumber++;
      logger.warn({ phoneNumberId: msg.phoneNumberId }, "message for a number that isn't connected to any coach");
      continue;
    }

    // While a coach is suspended: no AI and nothing new stored. An existing client gets one fixed notice from the worker.
    const suspended = t.status === "suspended";
    const client = suspended
      ? await findClientByPhone(db, t, msg.from)
      : (await findOrCreateClient(db, t, { phone: msg.from, channel: "whatsapp", approved: clientAccessMode(t.settings) === "open" })).client;
    if (!client || (suspended && !suspensionNoticeDue(t, client))) {
      stats.suspended++;
      continue;
    }
    const body: StoredBody = suspended ? {} : { text: msg.text, buttonId: msg.buttonId, mediaId: msg.mediaId, mimeType: msg.mimeType };
    const runAt = new Date(now.getTime() + opts.debounceMs);

    // The inbound row de-duplicates Meta's redeliveries, so it goes in first.
    const [inserted] = await withTenant(db, t, (tx) =>
      tx
        .insert(inboundMessages)
        .values({
          coachId: t.coachId,
          clientId: client.id,
          phoneNumberId: msg.phoneNumberId,
          externalId: msg.id,
          kind: msg.kind,
          bodyEnc: encryptJson(t, body),
          sentAt: msg.timestamp,
        })
        .onConflictDoNothing({ target: inboundMessages.externalId })
        .returning({ id: inboundMessages.id }),
    );
    if (!inserted) {
      stats.duplicates++;
      continue;
    }
    await recordMessages(db, t, client.id, "message_in");

    // Counters and spend are platform data, so they're checked outside the tenant scope (and before the turn is queued).
    const hold = suspended ? null : await holdReason(db, t, client, opts, now);
    if (hold) {
      await holdMessage(db, t, client, msg, inserted.id, hold);
      if (hold.status === "over_cap") stats.overCap++;
      else stats.rateLimited++;
      continue;
    }
    // Every new message pushes the client's turn back by the debounce window, so a burst of messages is
    // answered once, after the client pauses. (If this fails after the insert, the client's next message
    // queues the turn and the worker picks up every pending message.)
    await withTenant(db, t, (tx) =>
      tx
        .insert(turnJobs)
        .values({ clientId: client.id, coachId: t.coachId, phoneNumberId: msg.phoneNumberId, runAt })
        .onConflictDoUpdate({ target: turnJobs.clientId, set: { runAt, phoneNumberId: msg.phoneNumberId } }),
    );
    stats.queued++;
  }
  return stats;
}

interface Hold {
  status: "rate_limited" | "over_cap";
  /** Only the first held message in a window opens an alert. */
  alert: { type: AlertType; severity: Severity; summary: string } | null;
}

const CLIENT_WINDOWS = [
  { option: "clientHourlyLimit", key: "client-messages", ms: CLIENT_RATE_WINDOW_MS, period: "in the last hour", until: "the hour passes" },
  { option: "clientDailyLimit", key: "client-messages-day", ms: CLIENT_DAY_WINDOW_MS, period: "in the last 24 hours", until: "the day passes" },
] as const;

/** Whether the bot must not answer this message: the client's limits first, then the spending caps. */
async function holdReason(db: Db, t: TenantContext, client: ClientRow, opts: EnqueueOptions, now: Date): Promise<Hold | null> {
  for (const w of CLIENT_WINDOWS) {
    const limit = opts[w.option] ?? 0;
    if (limit <= 0) continue;
    const count = await hitRateLimit(db, `${w.key}:${client.id}`, w.ms, now);
    if (count <= limit) continue;
    const summary = `The client sent more than ${limit} messages ${w.period}. The bot won't answer until ${w.until}; the messages are kept here in the conversation.`;
    return { status: "rate_limited", alert: count === limit + 1 ? { type: "rate_limited", severity: "medium", summary } : null };
  }
  if (!opts.spendCaps) return null;
  const block = await spendBlock(db, t, opts.spendCaps, now);
  if (!block) return null;
  // One alert per coach per day, on the client whose message ran into the cap.
  const first = (await hitRateLimit(db, `spend-alert:${t.coachId}`, CLIENT_DAY_WINDOW_MS, now)) === 1;
  if (first) {
    const fields = { coachId: t.coachId, scope: block.scope, capUsd: block.capUsd };
    if (block.scope === "platform") logger.error(fields, "platform daily spending cap reached: every bot is holding messages");
    else logger.warn(fields, "coach monthly spending cap reached: holding messages");
  }
  return { status: "over_cap", alert: first ? { type: "spend_cap", severity: "high", summary: spendBlockMessage(block) } : null };
}

/**
 * A message the bot won't answer (a client over their limit, or a spending cap): no turn and no AI cost, but
 * the coach sees it in the conversation, the bot reads it as context on its next turn, and the first one in a
 * window opens an alert. The text is kept only for a client who consented, like every other stored message.
 */
async function holdMessage(db: Db, t: TenantContext, client: ClientRow, msg: InboundWaMessage, inboundId: string, hold: Hold): Promise<void> {
  await withTenant(db, t, (tx) => tx.update(inboundMessages).set({ status: hold.status, bodyEnc: null }).where(eq(inboundMessages.id, inboundId)));
  await updateClient(db, t, client.id, { lastInboundAt: msg.timestamp });
  await logChatMessage(db, t, {
    clientId: client.id,
    direction: "in",
    sender: "client",
    kind: msg.kind === "text" ? "text" : msg.kind,
    body: client.consentStatus === "granted" ? msg.text || null : null,
    externalId: msg.id,
    botSeen: false,
  });
  if (hold.alert) await createAlert(db, t, { clientId: client.id, source: "system", ...hold.alert });
}

export async function applyStatuses(db: Db, statuses: StatusUpdate[]): Promise<void> {
  for (const s of statuses) {
    await applyDeliveryStatus(db, s.messageId, s.status);
    if (s.status === "failed") {
      logger.warn({ messageId: s.messageId, code: s.errorCode, title: s.errorTitle }, "WhatsApp delivery failed");
    }
  }
}

export type TurnJob = typeof turnJobs.$inferSelect;

/**
 * Claims due jobs. FOR UPDATE SKIP LOCKED lets several workers (or replicas) poll the same table without
 * taking each other's rows; the lease (locked_until) frees a job if its worker dies mid-turn.
 * Platform path: the queue spans all coaches, so claiming and the job bookkeeping below run unscoped.
 */
export async function claimDueJobs(
  db: Db,
  opts: { now: Date; limit: number; leaseMs: number; exclude?: ReadonlySet<string> },
): Promise<TurnJob[]> {
  if (opts.limit <= 0) return [];
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(turnJobs)
      .where(and(lte(turnJobs.runAt, opts.now), or(isNull(turnJobs.lockedUntil), lt(turnJobs.lockedUntil, opts.now))))
      .orderBy(asc(turnJobs.runAt))
      .limit(opts.limit + (opts.exclude?.size ?? 0))
      .for("update", { skipLocked: true });
    const claimed = due.filter((j) => !opts.exclude?.has(j.clientId)).slice(0, opts.limit);
    if (claimed.length === 0) return [];
    const lockedUntil = new Date(opts.now.getTime() + opts.leaseMs);
    await tx
      .update(turnJobs)
      .set({ lockedUntil, attempts: sql`${turnJobs.attempts} + 1` })
      .where(inArray(turnJobs.clientId, claimed.map((j) => j.clientId)));
    return claimed.map((j) => ({ ...j, lockedUntil, attempts: j.attempts + 1 }));
  });
}

export interface PendingInbound {
  id: string;
  externalId: string;
  kind: InboundKind;
  text: string;
  buttonId?: string;
  mediaId?: string;
  mimeType?: string;
  sentAt: Date;
}

export async function listPendingInbound(db: Db, t: TenantContext, clientId: string): Promise<PendingInbound[]> {
  const rows = await withTenant(db, t, (db) =>
    db
      .select()
      .from(inboundMessages)
      .where(and(eq(inboundMessages.coachId, t.coachId), eq(inboundMessages.clientId, clientId), eq(inboundMessages.status, "pending")))
      .orderBy(asc(inboundMessages.sentAt), asc(inboundMessages.createdAt)),
  );
  return rows.map((r) => {
    const body = r.bodyEnc ? decryptJson<StoredBody>(t, r.bodyEnc) : {};
    return {
      id: r.id,
      externalId: r.externalId,
      kind: r.kind as InboundKind,
      text: body.text ?? "",
      buttonId: body.buttonId,
      mediaId: body.mediaId,
      mimeType: body.mimeType,
      sentAt: r.sentAt,
    };
  });
}

/** Marks messages handled and drops their stored bodies (chat_messages keeps the readable record). */
export async function markInbound(db: Db, ids: string[], status: "done" | "failed"): Promise<void> {
  if (ids.length === 0) return;
  await db.update(inboundMessages).set({ status, bodyEnc: null }).where(inArray(inboundMessages.id, ids));
}

/** Removes the job, unless new messages arrived meanwhile; then it's released to run again. */
export async function finishJob(db: Db, clientId: string): Promise<void> {
  const pending = db
    .select({ one: sql`1` })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.clientId, clientId), eq(inboundMessages.status, "pending")));
  const deleted = await db
    .delete(turnJobs)
    .where(and(eq(turnJobs.clientId, clientId), notExists(pending)))
    .returning({ id: turnJobs.clientId });
  if (deleted.length === 0) {
    await db.update(turnJobs).set({ lockedUntil: null, attempts: 0, lastError: null }).where(eq(turnJobs.clientId, clientId));
  }
}

export const MAX_JOB_ATTEMPTS = 5;

/** Retries with backoff; after MAX_JOB_ATTEMPTS the client's pending messages are marked failed. */
export async function failJob(db: Db, job: TurnJob, error: string, now: Date): Promise<"retry" | "gave_up"> {
  if (job.attempts >= MAX_JOB_ATTEMPTS) {
    const pending = await db
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .where(and(eq(inboundMessages.clientId, job.clientId), eq(inboundMessages.status, "pending")));
    await markInbound(db, pending.map((p) => p.id), "failed");
    await db.delete(turnJobs).where(eq(turnJobs.clientId, job.clientId));
    return "gave_up";
  }
  const runAt = new Date(now.getTime() + 15_000 * 2 ** (job.attempts - 1));
  await db
    .update(turnJobs)
    .set({ runAt, lockedUntil: null, lastError: error.slice(0, 500) })
    .where(eq(turnJobs.clientId, job.clientId));
  return "retry";
}

/** Housekeeping: processed inbound rows are only needed for de-duplication of late redeliveries. */
export async function purgeProcessedInbound(db: Db, olderThan: Date): Promise<number> {
  const rows = await db
    .delete(inboundMessages)
    .where(and(inArray(inboundMessages.status, ["done", "failed", "rate_limited", "over_cap"]), lt(inboundMessages.createdAt, olderThan)))
    .returning({ id: inboundMessages.id });
  return rows.length;
}
