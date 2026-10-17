import { and, desc, eq, gte } from "drizzle-orm";
import { decryptOptional, decryptText, encryptOptional, encryptText } from "../crypto";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { alerts, auditLog, usageEvents } from "../db/schema";
import { estimateCostMicros, type MessageKind } from "../pricing";
import type { TenantContext } from "../tenancy";

export const ALERT_TYPES = [
  "unknown_question",
  "medical",
  "eating_disorder",
  "minor",
  "mental_health",
  "substances",
  "paused_message",
  "bot_error",
  "rate_limited",
  "other",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const SEVERITIES = ["low", "medium", "high", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AlertInput {
  clientId: string;
  type: AlertType;
  severity: Severity;
  source: "model" | "detector" | "system";
  summary: string;
  question?: string | null;
}

export interface Alert {
  id: string;
  clientId: string;
  type: AlertType;
  severity: Severity;
  source: string;
  summary: string;
  question: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: Date;
}

/**
 * Opens an alert for the coach's "needs attention" queue. Safety alerts of the same type for the same
 * client are merged within `dedupeHours` so a repeated symptom doesn't flood the queue. Unknown questions
 * are never merged: each is a separate thing the coach should answer.
 */
export async function createAlert(
  db: Db,
  t: TenantContext,
  input: AlertInput,
  dedupeHours = 24,
): Promise<{ id: string; deduped: boolean }> {
  return withTenant(db, t, async (db) => {
    if (input.type !== "unknown_question") {
      const since = new Date(Date.now() - dedupeHours * 3600_000);
      const [existing] = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(
          and(
            eq(alerts.coachId, t.coachId),
            eq(alerts.clientId, input.clientId),
            eq(alerts.type, input.type),
            eq(alerts.status, "open"),
            gte(alerts.createdAt, since),
          ),
        )
        .limit(1);
      if (existing) return { id: existing.id, deduped: true };
    }
    const [row] = await db
      .insert(alerts)
      .values({
        coachId: t.coachId,
        clientId: input.clientId,
        type: input.type,
        severity: input.severity,
        source: input.source,
        summaryEnc: encryptText(t, input.summary),
        questionEnc: encryptOptional(t, input.question),
      })
      .returning({ id: alerts.id });
    if (!row) throw new Error("Alert insert failed");
    return { id: row.id, deduped: false };
  });
}

export async function listAlerts(
  db: Db,
  t: TenantContext,
  opts: { status?: "open" | "resolved"; clientId?: string } = {},
): Promise<Alert[]> {
  const conditions = [eq(alerts.coachId, t.coachId)];
  if (opts.status) conditions.push(eq(alerts.status, opts.status));
  if (opts.clientId) conditions.push(eq(alerts.clientId, opts.clientId));
  const rows = await withTenant(db, t, (db) =>
    db
      .select()
      .from(alerts)
      .where(and(...conditions))
      .orderBy(desc(alerts.createdAt)),
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    type: r.type as AlertType,
    severity: r.severity as Severity,
    source: r.source,
    summary: decryptText(t, r.summaryEnc),
    question: decryptOptional(t, r.questionEnc),
    status: r.status as "open" | "resolved",
    resolution: decryptOptional(t, r.resolutionEnc),
    createdAt: r.createdAt,
  }));
}

export async function resolveAlert(db: Db, t: TenantContext, alertId: string, resolution: string | null): Promise<void> {
  await withTenant(db, t, (db) =>
    db
      .update(alerts)
      .set({ status: "resolved", resolvedAt: new Date(), resolutionEnc: encryptOptional(t, resolution) })
      .where(and(eq(alerts.coachId, t.coachId), eq(alerts.id, alertId))),
  );
}

export interface UsageInput {
  clientId?: string | null;
  kind: "chat" | "summary" | "ingest" | "embedding" | "transcription" | MessageKind;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Messages, for the message kinds. */
  quantity?: number;
}

/** Records one billable event with its estimated cost (pricing.ts). Usage rows outlive deleted clients. */
export async function recordUsage(db: Db, t: TenantContext, u: UsageInput): Promise<void> {
  await withTenant(db, t, (db) =>
    db.insert(usageEvents).values({
      coachId: t.coachId,
      clientId: u.clientId ?? null,
      kind: u.kind,
      model: u.model,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      quantity: u.quantity ?? 0,
      costMicros: estimateCostMicros(u),
    }),
  );
}

/** WhatsApp messages in or out of the coach's number, counted for usage (free in the service window, templates are not). */
export async function recordMessages(db: Db, t: TenantContext, clientId: string | null, kind: MessageKind, quantity = 1): Promise<void> {
  if (quantity > 0) await recordUsage(db, t, { clientId, kind, model: "whatsapp", quantity });
}

export async function audit(
  db: Db,
  t: TenantContext,
  entry: { actor: string; action: string; targetType: string; targetId?: string; meta?: Record<string, unknown> },
): Promise<void> {
  await withTenant(db, t, (db) =>
    db.insert(auditLog).values({
      coachId: t.coachId,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      meta: entry.meta ?? {},
    }),
  );
}

export async function listAudit(db: Db, t: TenantContext, limit = 100) {
  return withTenant(db, t, (db) =>
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.coachId, t.coachId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit),
  );
}
