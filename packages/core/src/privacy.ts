import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./db/client";
import { clients } from "./db/schema";
import { clientPhone, getMemory, getProfile, requireClient } from "./repos/clients";
import { listChatMessages } from "./repos/conversation";
import { audit, listAlerts } from "./repos/ops";
import { getActiveMealPlan, getActiveWorkoutPlan, listMeals, listWeights, listWorkouts } from "./repos/tracking";
import type { TenantContext } from "./tenancy";

/** Everything stored about a client, decrypted: the answer to a data-access request. */
export async function exportClientData(db: Db, t: TenantContext, clientId: string, actor: string) {
  const client = await requireClient(db, t, clientId);
  const data = {
    exportedAt: new Date().toISOString(),
    coach: t.coachName,
    client: {
      id: client.id,
      phone: clientPhone(t, client),
      channel: client.channel,
      createdAt: client.createdAt,
      consent: { status: client.consentStatus, at: client.consentAt, version: client.consentVersion },
      flags: client.flags,
    },
    profile: await getProfile(db, t, clientId),
    memory: await getMemory(db, t, clientId),
    weights: await listWeights(db, t, clientId),
    meals: await listMeals(db, t, clientId),
    workouts: await listWorkouts(db, t, clientId),
    mealPlan: await getActiveMealPlan(db, t, clientId),
    workoutPlan: await getActiveWorkoutPlan(db, t, clientId),
    alerts: await listAlerts(db, t, { clientId }),
    messages: await listChatMessages(db, t, clientId, 10_000),
  };
  await audit(db, t, { actor, action: "client_export", targetType: "client", targetId: clientId });
  return data;
}

/**
 * Hard-deletes a client. Every table holding client data references clients(id) with ON DELETE CASCADE,
 * so one delete removes profile, memory, epochs, LLM history, chat log, logs, plans and alerts.
 * The audit entry keeps only the opaque id.
 */
export async function deleteClientData(db: Db, t: TenantContext, clientId: string, actor: string): Promise<boolean> {
  const deleted = await db
    .delete(clients)
    .where(and(eq(clients.coachId, t.coachId), eq(clients.id, clientId)))
    .returning({ id: clients.id });
  if (deleted.length === 0) return false;
  await audit(db, t, { actor, action: "client_deleted", targetType: "client", targetId: clientId });
  return true;
}

/** Retention policy: deletes clients with no inbound message for `months`. Returns how many were removed. */
export async function purgeInactiveClients(db: Db, t: TenantContext, months: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const stale = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.coachId, t.coachId),
        or(lt(clients.lastInboundAt, cutoff), and(isNull(clients.lastInboundAt), lt(clients.createdAt, cutoff))),
      ),
    );
  for (const c of stale) await deleteClientData(db, t, c.id, "retention_policy");
  return stale.length;
}
