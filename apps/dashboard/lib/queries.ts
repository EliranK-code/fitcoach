import { and, count, desc, eq, gte, max, sql } from "drizzle-orm";
import {
  clientPhone,
  getActiveMealPlan,
  getActiveWorkoutPlan,
  getCoachAccount,
  getMemory,
  getProfile,
  listClientReminders,
  listAlerts,
  listChatMessages,
  listClients,
  listMeals,
  listWeights,
  listWorkouts,
  requireClient,
  schema,
  serviceWindowOpen,
  type ClientProfile,
  type Db,
  type TenantContext,
} from "@fitcoach/core";

// Read models for the dashboard. Plain functions of (db, tenant) so they're testable without Next.js;
// every query is scoped to the tenant's coach.

export async function overviewStats(db: Db, t: TenantContext, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const alerts = await listAlerts(db, t, { status: "open" });
  const clients = await listClients(db, t);
  const [messages] = await db
    .select({ n: count() })
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.coachId, t.coachId), gte(schema.chatMessages.createdAt, dayAgo)));
  const real = clients.filter((c) => !c.isTest);
  return {
    openAlerts: alerts.length,
    urgentAlerts: alerts.filter((a) => a.severity === "urgent" || a.severity === "high").length,
    clients: real.length,
    activeClients: real.filter((c) => c.lastInboundAt && c.lastInboundAt > weekAgo).length,
    pausedClients: real.filter((c) => c.botPaused).length,
    messages24h: messages?.n ?? 0,
  };
}

export interface ClientRow {
  id: string;
  name: string;
  phone: string;
  channel: string;
  consentStatus: string;
  botPaused: boolean;
  flags: { minor?: boolean; eatingDisorderRisk?: boolean };
  lastInboundAt: Date | null;
  openAlerts: number;
  goal: string | null;
}

export async function clientRows(db: Db, t: TenantContext): Promise<ClientRow[]> {
  const clients = (await listClients(db, t)).filter((c) => !c.isTest);
  const alertCounts = await db
    .select({ clientId: schema.alerts.clientId, n: count() })
    .from(schema.alerts)
    .where(and(eq(schema.alerts.coachId, t.coachId), eq(schema.alerts.status, "open")))
    .groupBy(schema.alerts.clientId);
  const openBy = new Map(alertCounts.map((r) => [r.clientId, r.n]));
  const rows: ClientRow[] = [];
  for (const c of clients) {
    const profile = await getProfile(db, t, c.id);
    const phone = clientPhone(t, c);
    rows.push({
      id: c.id,
      name: profile.name ?? phone,
      phone,
      channel: c.channel,
      consentStatus: c.consentStatus,
      botPaused: c.botPaused,
      flags: c.flags,
      lastInboundAt: c.lastInboundAt,
      openAlerts: openBy.get(c.id) ?? 0,
      goal: profile.goal ?? null,
    });
  }
  return rows.sort((a, b) => (b.lastInboundAt?.getTime() ?? 0) - (a.lastInboundAt?.getTime() ?? 0));
}

export async function clientDetail(db: Db, t: TenantContext, clientId: string, now = new Date()) {
  const client = await requireClient(db, t, clientId);
  const profile: ClientProfile = await getProfile(db, t, clientId);
  const account = await getCoachAccount(db, t);
  const since = new Date(now.getTime() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
  return {
    client,
    phone: clientPhone(t, client),
    profile,
    memory: await getMemory(db, t, clientId),
    weights: await listWeights(db, t, clientId, since),
    meals: (await listMeals(db, t, clientId, since)).slice(-20).reverse(),
    workouts: (await listWorkouts(db, t, clientId, since)).slice(-10).reverse(),
    mealPlan: await getActiveMealPlan(db, t, clientId),
    workoutPlan: await getActiveWorkoutPlan(db, t, clientId),
    alerts: await listAlerts(db, t, { clientId }),
    reminders: await listClientReminders(db, t, clientId),
    messages: await listChatMessages(db, t, clientId, 200),
    canSendWhatsApp: client.channel === "whatsapp" && Boolean(account),
    windowOpen: serviceWindowOpen(client, now),
  };
}

export type ClientDetail = Awaited<ReturnType<typeof clientDetail>>;

/** Usage for the settings page: model calls and tokens over the last 30 days. */
export async function usageSummary(db: Db, t: TenantContext, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const rows = await db
    .select({
      kind: schema.usageEvents.kind,
      calls: count(),
      input: sql<number>`coalesce(sum(${schema.usageEvents.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${schema.usageEvents.outputTokens}), 0)::int`,
      cacheRead: sql<number>`coalesce(sum(${schema.usageEvents.cacheReadTokens}), 0)::int`,
      last: max(schema.usageEvents.createdAt),
    })
    .from(schema.usageEvents)
    .where(and(eq(schema.usageEvents.coachId, t.coachId), gte(schema.usageEvents.createdAt, since)))
    .groupBy(schema.usageEvents.kind)
    .orderBy(desc(count()));
  return rows;
}
