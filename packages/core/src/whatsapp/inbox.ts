import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../crypto";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { inboundMessages, turnJobs } from "../db/schema";
import { logger } from "../logger";
import { suspensionNoticeDue } from "../platform";
import { findClientByPhone, findOrCreateClient } from "../repos/clients";
import { applyDeliveryStatus } from "../repos/conversation";
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
}

export async function enqueueInbound(
  db: Db,
  messages: InboundWaMessage[],
  opts: { debounceMs: number; now?: Date },
): Promise<EnqueueStats> {
  const stats: EnqueueStats = { queued: 0, duplicates: 0, ignored: 0, unknownNumber: 0, suspended: 0 };
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
      : (await findOrCreateClient(db, t, { phone: msg.from, channel: "whatsapp" })).client;
    if (!client || (suspended && !suspensionNoticeDue(t, client))) {
      stats.suspended++;
      continue;
    }
    const body: StoredBody = suspended ? {} : { text: msg.text, buttonId: msg.buttonId, mediaId: msg.mediaId, mimeType: msg.mimeType };
    const runAt = new Date(now.getTime() + opts.debounceMs);

    const queued = await withTenant(db, t, async (tx) => {
      const inserted = await tx
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
        .returning({ id: inboundMessages.id });
      if (inserted.length === 0) return false;
      // Every new message pushes the client's turn back by the debounce window, so a burst of
      // messages is answered once, after the client pauses.
      await tx
        .insert(turnJobs)
        .values({ clientId: client.id, coachId: t.coachId, phoneNumberId: msg.phoneNumberId, runAt })
        .onConflictDoUpdate({ target: turnJobs.clientId, set: { runAt, phoneNumberId: msg.phoneNumberId } });
      return true;
    });
    if (queued) stats.queued++;
    else stats.duplicates++;
  }
  return stats;
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
    .where(and(inArray(inboundMessages.status, ["done", "failed"]), lt(inboundMessages.createdAt, olderThan)))
    .returning({ id: inboundMessages.id });
  return rows.length;
}
