import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticate, createCoachUser, createSession, validateSession } from "../src/auth";
import type { AppConfig } from "../src/config";
import { decryptJson } from "../src/crypto";
import { openDatabase, type Db, type DbHandle } from "../src/db/client";
import { TenantScopeError, withTenant } from "../src/db/scope";
import { alerts, auditLog, clientProfiles, clients, inboundMessages, platformAudit, reminders, sessions, turnJobs } from "../src/db/schema";
import { importCoachFromDir } from "../src/knowledge/importer";
import { getKnowledge, publishKnowledge, searchKnowledge } from "../src/knowledge/store";
import type { CreateParams } from "../src/llm/client";
import { ReminderScheduler } from "../src/reminders/scheduler";
import { zonedTimeToUtc } from "../src/reminders/schedule";
import { setClientReminders } from "../src/reminders/store";
import { findClientByPhone, findOrCreateClient, getProfile, saveMemory, saveProfile, type ClientRow } from "../src/repos/clients";
import { appendEpochMessages, createEpoch, listChatMessages, logChatMessage } from "../src/repos/conversation";
import { audit, createAlert, recordUsage } from "../src/repos/ops";
import { addMeal, addWeight, addWorkout, saveMealPlan, saveWorkoutPlan } from "../src/repos/tracking";
import { deleteCoach, listCoaches, listPlatformAudit, resumeCoach, suspendCoach, suspendedNoticeText } from "../src/platform";
import { CoachSuspendedError, createCoach, openTenant, TenantNotFoundError, type TenantContext } from "../src/tenancy";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { createDryRunApi } from "../src/whatsapp/api";
import { enqueueInbound } from "../src/whatsapp/inbox";
import type { InboundWaMessage } from "../src/whatsapp/webhook";
import { InboundWorker } from "../src/whatsapp/worker";
import { createTestApp, message, SEED_DIR, testConfig, text, type TestApp } from "./helpers";

const SECRET_B = "המתכון הסודי של המאמנת השנייה: שייק בננה וחמאת בוטנים";

/** Coach B: a copy of the demo coach's knowledge under another name, plus a document only B has. */
async function addSecondCoach(db: Db, a: TenantContext): Promise<TenantContext> {
  const b = await openTenant(db, await createCoach(db, { slug: "other", name: "מאמנת אחרת" }));
  const data = (await getKnowledge(db, a))!.data;
  await publishKnowledge(
    db,
    b,
    {
      data: { ...data, coach: { ...data.coach, name: "מאמנת אחרת" } },
      documents: [{ title: "סודות", filename: "secret.md", mime: "text/markdown", text: SECRET_B }],
    },
    null,
  );
  return b;
}

const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows);

/** Runs an operation that must fail and returns its error text (driver errors are wrapped as `cause`). */
async function failure(op: Promise<unknown>): Promise<string> {
  try {
    await op;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ""}`;
  }
  throw new Error("expected the operation to fail");
}

/** Writes at least one row into every tenant table, through the normal repositories. */
async function populate(db: Db, cfg: AppConfig, t: TenantContext, pnid: string, now: Date): Promise<ClientRow> {
  await publishKnowledge(db, t, { addDocuments: [{ title: "מסמך", filename: "doc.md", mime: "text/markdown", text: `מסמך של ${t.coachName}` }] }, null);
  await connectWhatsAppNumber(db, t, { phoneNumberId: pnid });
  const { client } = await findOrCreateClient(db, t, { phone: "972500000001", channel: "whatsapp" });
  await saveProfile(db, t, client.id, { name: `לקוח של ${t.coachName}` });
  await saveMemory(db, t, client.id, "סיכום", null);
  const epoch = await createEpoch(db, t, client.id, [{ type: "text", text: "system" }], "hash");
  await appendEpochMessages(db, t, epoch, [{ role: "user", content: "שלום" }], { contextTokens: 10, now });
  await logChatMessage(db, t, { clientId: client.id, direction: "in", sender: "client", body: "שלום" });
  await addWeight(db, t, client.id, 80, "2026-10-01");
  await addMeal(db, t, client.id, { eatenOn: "2026-10-01", mealType: "breakfast", description: "חביתה", estCalories: 300, estProteinG: 20 });
  await addWorkout(db, t, client.id, { performedOn: "2026-10-01", title: "רגליים", durationMin: 45, exercises: [], notes: null });
  await saveMealPlan(db, t, client.id, { planText: "תפריט", dailyCalories: 1800, proteinG: 120, showNumbers: true });
  await saveWorkoutPlan(db, t, client.id, { planText: "תוכנית", days: [], progressionRule: "+2.5 ק״ג" });
  await createAlert(db, t, { clientId: client.id, type: "other", severity: "low", source: "system", summary: "בדיקה" });
  await recordUsage(db, t, { clientId: client.id, kind: "chat", model: "claude-opus-5-5", inputTokens: 10 });
  await setClientReminders(db, t, cfg, client.id, [{ kind: "weigh_in", days: [0], time: "08:00" }], now);
  const inbound: InboundWaMessage = { phoneNumberId: pnid, from: "972500000001", id: `wamid.${pnid}`, timestamp: now, kind: "text", text: "שלום" };
  await enqueueInbound(db, [inbound], { debounceMs: 0, now });
  const user = await createCoachUser(db, { coachId: t.coachId, email: `${pnid}@example.com`, password: "test-password-123" });
  await createSession(db, user, now);
  await audit(db, t, { actor: "test", action: "populate", targetType: "client", targetId: client.id });
  return client;
}

async function publicTables(db: Db): Promise<{ name: string; rls: boolean; policies: number }[]> {
  return rows(
    await db.execute(sql`
      select c.relname as name, c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`),
  );
}

/** Platform-only tables: RLS on, no tenant policy, no tenant privileges. */
const PLATFORM_TABLES = ["platform_admins", "platform_audit", "platform_sessions", "user_tokens"];

const ownerColumn = (table: string) => (table === "coaches" ? "id" : "coach_id");

/** Rows in `table` matching `where`, read in a tenant scope for `t`, or unscoped (as the owner) when t is null. */
async function countAs(db: Db, t: TenantContext | null, table: string, where = "true"): Promise<number> {
  const query = sql.raw(`select count(*)::int as n from "${table}" where ${where}`);
  const result = t ? await withTenant(db, t, (db) => db.execute(query)) : await db.execute(query);
  return rows<{ n: number }>(result)[0]!.n;
}

describe("row-level security", () => {
  let handle: DbHandle;
  let a: TenantContext;
  let b: TenantContext;
  let clientB: ClientRow;
  const cfg = testConfig();
  const now = new Date("2026-10-18T05:00:00Z");

  beforeAll(async () => {
    handle = await openDatabase({});
    const imported = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
    a = await openTenant(handle.db, imported.coachId);
    b = await addSecondCoach(handle.db, a);
    await populate(handle.db, cfg, a, "pn-a", now);
    clientB = await populate(handle.db, cfg, b, "pn-b", now);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("is enabled on every table, with a tenant policy everywhere except platform tables", async () => {
    const tables = await publicTables(handle.db);
    expect(tables.length).toBe(28);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => t.policies === 0).map((t) => t.name)).toEqual(PLATFORM_TABLES);
  });

  it("gives tenants no access to platform tables", async () => {
    await handle.db.insert(platformAudit).values({ actor: "test", action: "probe", coachId: a.coachId });
    expect(await failure(withTenant(handle.db, a, (db) => db.select().from(platformAudit)))).toMatch(/permission denied/);
    expect(await failure(withTenant(handle.db, a, (db) => db.insert(platformAudit).values({ actor: "x", action: "x" })))).toMatch(/permission denied/);
    for (const table of PLATFORM_TABLES) {
      expect(await failure(withTenant(handle.db, a, (db) => db.execute(sql.raw(`select count(*) from "${table}"`)))), table).toMatch(/permission denied/);
    }
  });

  it("shows a scoped query only its own coach's rows, in every table, even without a coach filter", async () => {
    for (const { name } of await publicTables(handle.db)) {
      if (PLATFORM_TABLES.includes(name)) continue;
      const col = ownerColumn(name);
      for (const [mine, theirs] of [
        [a, b],
        [b, a],
      ] as const) {
        const owned = await countAs(handle.db, null, name, `${col} = '${mine.coachId}'`);
        expect(owned, `${name}: test data for ${mine.coachName}`).toBeGreaterThan(0);
        expect(await countAs(handle.db, mine, name), name).toBe(owned);
        expect(await countAs(handle.db, mine, name, `${col} = '${theirs.coachId}'`), name).toBe(0);
      }
    }
  });

  it("sees nothing as the tenant role without a coach", async () => {
    const n = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'app_tenant', true)`);
      return rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from clients`))[0]!.n;
    });
    expect(n).toBe(0);
    expect(await countAs(handle.db, null, "clients")).toBe(2); // the role is transaction-local
  });

  it("blocks inserting, updating or deleting another coach's rows", async () => {
    const { id: _id, ...copy } = clientB;
    expect(await failure(withTenant(handle.db, a, (db) => db.insert(clients).values({ ...copy, phoneHash: "x" })))).toMatch(
      /row-level security/,
    );
    const updated = await withTenant(handle.db, a, (db) =>
      db.update(clients).set({ botPaused: true }).where(eq(clients.coachId, b.coachId)).returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withTenant(handle.db, a, (db) => db.delete(alerts).where(eq(alerts.coachId, b.coachId)).returning());
    expect(deleted).toEqual([]);
    expect(await countAs(handle.db, null, "alerts", `coach_id = '${b.coachId}'`)).toBe(1);
    expect((await handle.db.select().from(clients).where(eq(clients.id, clientB.id)))[0]!.botPaused).toBe(false);
  });

  it("stops a repository given another coach's client id from overwriting that client", async () => {
    // client_profiles is keyed by client_id, so this upsert used to land on B's row, encrypted with A's key.
    expect(await failure(saveProfile(handle.db, a, clientB.id, { name: "חטיפה" }))).toMatch(/row-level security/);
    expect(await failure(saveMemory(handle.db, a, clientB.id, "חטיפה", null))).toMatch(/row-level security/);
    expect((await getProfile(handle.db, b, clientB.id)).name).toBe("לקוח של מאמנת אחרת");
  });

  it("keeps audit and usage records append-only for tenants", async () => {
    expect(await failure(withTenant(handle.db, a, (db) => db.delete(auditLog)))).toMatch(/permission denied/);
    expect(await failure(withTenant(handle.db, a, (db) => db.update(auditLog).set({ action: "x" })))).toMatch(/permission denied/);
    expect(await countAs(handle.db, null, "audit_log", `coach_id = '${a.coachId}'`)).toBeGreaterThan(0);
  });

  it("refuses a scope for one coach nested inside another's", async () => {
    await expect(withTenant(handle.db, a, (db) => withTenant(db, b, async () => 1))).rejects.toThrow(TenantScopeError);
    expect(await withTenant(handle.db, a, (db) => withTenant(db, a, async () => 1))).toBe(1);
  });
});

describe("two coaches end to end", () => {
  let app: TestApp;
  let a: TenantContext;
  let b: TenantContext;
  let apiA: ReturnType<typeof createDryRunApi>;
  let apiB: ReturnType<typeof createDryRunApi>;
  let worker: InboundWorker;
  let seq = 0;
  const TZ = "Asia/Jerusalem";
  const FROM = "972507770000"; // the same person writes to both coaches

  /** Answers as whichever coach's knowledge is in the system prompt, so a misrouted turn shows up in the reply. */
  const replyAsCoach = (p: CreateParams) => message([text(JSON.stringify(p.system).includes(SECRET_B) ? "[B] תשובה" : "[A] תשובה")]);

  const incoming = (phoneNumberId: string, body: string, extra: Partial<InboundWaMessage> = {}): InboundWaMessage => ({
    phoneNumberId,
    from: FROM,
    id: `wamid.e2e.${++seq}`,
    timestamp: app.clock.now,
    kind: "text",
    text: body,
    ...extra,
  });
  const deliver = async (...msgs: InboundWaMessage[]) => {
    await enqueueInbound(app.handle.db, msgs, { debounceMs: 4000, now: app.clock.now });
    app.clock.now = new Date(app.clock.now.getTime() + 4001);
    return worker.tick();
  };
  const textsTo = (api: typeof apiA) => api.sent.filter((e) => e.type === "text").map((e) => e.body ?? "");

  beforeEach(async () => {
    app = await createTestApp({ WORKER_CONCURRENCY: "4" });
    app.clock.now = zonedTimeToUtc("2026-10-18", "07:00", TZ); // Sunday morning
    a = await app.tenant();
    b = await addSecondCoach(app.handle.db, a);
    await connectWhatsAppNumber(app.handle.db, a, { phoneNumberId: "pn-a" });
    await connectWhatsAppNumber(app.handle.db, b, { phoneNumberId: "pn-b" });
    apiA = createDryRunApi("pn-a", () => {});
    apiB = createDryRunApi("pn-b", () => {});
    const apiFor = async (t: TenantContext) => (t.coachId === a.coachId ? apiA : apiB);
    worker = new InboundWorker({ db: app.handle.db, cfg: app.cfg, engine: app.engine, apiFor, now: () => app.clock.now });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  it("keeps parallel conversations, knowledge and reminders apart", async () => {
    // One webhook batch with messages for both numbers; the worker runs both turns concurrently.
    expect(await deliver(incoming("pn-a", "היי"), incoming("pn-b", "היי"))).toBe(2);
    app.llm.push(replyAsCoach, replyAsCoach, replyAsCoach, replyAsCoach);
    const accept = { kind: "button", buttonId: "consent_yes" } as const;
    expect(await deliver(incoming("pn-a", "מאשר/ת ✅", accept), incoming("pn-b", "מאשר/ת ✅", accept))).toBe(2);
    expect(await deliver(incoming("pn-a", "הודעה למאמן א"), incoming("pn-b", "הודעה למאמנת ב"))).toBe(2);

    // Each number answered only with its own coach's knowledge.
    expect(textsTo(apiA).filter((t) => t.includes("תשובה"))).toEqual(["[A] תשובה", "[A] תשובה"]);
    expect(textsTo(apiB).filter((t) => t.includes("תשובה"))).toEqual(["[B] תשובה", "[B] תשובה"]);
    expect([...apiA.sent, ...apiB.sent].every((e) => e.type === "read" || e.to === FROM)).toBe(true);

    // The model never saw the other coach's conversation.
    const requests = app.llm.chatRequests.map((r) => ({ isB: JSON.stringify(r.system).includes(SECRET_B), messages: JSON.stringify(r.messages) }));
    expect(requests.filter((r) => r.isB)).toHaveLength(2);
    expect(requests.filter((r) => !r.isB)).toHaveLength(2);
    for (const r of requests) expect(r.messages).not.toContain(r.isB ? "הודעה למאמן א" : "הודעה למאמנת ב");

    // Same phone, two separate clients with separate histories.
    const clientA = (await findClientByPhone(app.handle.db, a, FROM))!;
    const clientB = (await findClientByPhone(app.handle.db, b, FROM))!;
    expect(clientA.id).not.toBe(clientB.id);
    const historyA = (await listChatMessages(app.handle.db, a, clientA.id)).map((m) => m.body ?? "").join("\n");
    expect(historyA).toContain("הודעה למאמן א");
    expect(historyA).not.toContain("הודעה למאמנת ב");
    expect(await listChatMessages(app.handle.db, a, clientB.id)).toEqual([]);

    // Knowledge search stays within the coach.
    const hitsA = await searchKnowledge(app.handle.db, a, "המתכון הסודי בננה", null);
    expect(hitsA.some((h) => h.content.includes("המתכון הסודי"))).toBe(false);
    expect((await searchKnowledge(app.handle.db, b, "המתכון הסודי בננה", null))[0]?.content).toContain("המתכון הסודי");

    // The reminder scheduler spans all coaches, but each reminder goes out through its own coach's number.
    for (const [t, client] of [
      [a, clientA],
      [b, clientB],
    ] as const) {
      await setClientReminders(app.handle.db, t, app.cfg, client.id, [{ kind: "weigh_in", days: [0], time: "08:30" }], app.clock.now);
    }
    const sentBefore = { a: apiA.sent.length, b: apiB.sent.length };
    app.clock.now = zonedTimeToUtc("2026-10-18", "08:31", TZ);
    const scheduler = new ReminderScheduler({
      db: app.handle.db,
      cfg: app.cfg,
      apiFor: async (t) => (t.coachId === a.coachId ? apiA : apiB),
      now: () => app.clock.now,
    });
    expect(await scheduler.tick()).toMatchObject({ sent: 2 });
    expect(apiA.sent.slice(sentBefore.a)).toEqual([expect.objectContaining({ type: "text", to: FROM })]);
    expect(apiB.sent.slice(sentBefore.b)).toEqual([expect.objectContaining({ type: "text", to: FROM })]);
  });
});

describe("coach lifecycle", () => {
  let app: TestApp;
  let db: Db;
  let a: TenantContext;
  let b: TenantContext;
  let clientB: ClientRow;
  let apiA: ReturnType<typeof createDryRunApi>;
  let apiB: ReturnType<typeof createDryRunApi>;
  let worker: InboundWorker;
  let seq = 0;
  const IL = "Asia/Jerusalem";
  const PHONE = "972500000001"; // the client populate() creates for each coach

  const msg = (phoneNumberId: string, from: string, body: string): InboundWaMessage => ({
    phoneNumberId,
    from,
    id: `wamid.life.${++seq}`,
    timestamp: app.clock.now,
    kind: "text",
    text: body,
  });
  const receive = (...msgs: InboundWaMessage[]) => enqueueInbound(db, msgs, { debounceMs: 0, now: app.clock.now });
  const textsB = () => apiB.sent.filter((e) => e.type === "text");
  const apiFor = async (t: TenantContext) => (t.coachId === b.coachId ? apiB : apiA);

  beforeEach(async () => {
    app = await createTestApp();
    db = app.handle.db;
    app.clock.now = zonedTimeToUtc("2026-10-18", "07:00", IL); // Sunday morning
    a = await app.tenant();
    b = await addSecondCoach(db, a);
    await populate(db, app.cfg, a, "pn-a", app.clock.now);
    clientB = await populate(db, app.cfg, b, "pn-b", app.clock.now);
    apiA = createDryRunApi("pn-a", () => {});
    apiB = createDryRunApi("pn-b", () => {});
    worker = new InboundWorker({ db, cfg: app.cfg, engine: app.engine, apiFor, now: () => app.clock.now });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  it("suspends logins, queued turns and reminders, and resuming brings them back without a reminder burst", async () => {
    const user = await createCoachUser(db, { coachId: b.coachId, email: "coach-b@example.com", password: "a-long-password-1" });
    const { token } = await createSession(db, user, app.clock.now);

    expect(await suspendCoach(db, b.coachId, "test", app.clock.now)).toBe(true);
    expect(await suspendCoach(db, b.coachId, "test", app.clock.now)).toBe(false);
    expect(await authenticate(db, "coach-b@example.com", "a-long-password-1")).toEqual({ ok: false, reason: "suspended" });
    expect(await authenticate(db, "coach-b@example.com", "a-wrong-password")).toEqual({ ok: false, reason: "invalid" });
    expect(await validateSession(db, token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.coachId, b.coachId))).toEqual([]);
    // The turn that was waiting in the queue is cancelled and its content dropped.
    expect(await db.select().from(turnJobs).where(eq(turnJobs.coachId, b.coachId))).toEqual([]);
    const inbound = await db.select().from(inboundMessages).where(eq(inboundMessages.coachId, b.coachId));
    expect(inbound.map((m) => [m.status, m.bodyEnc])).toEqual([["failed", null]]);
    await expect(openTenant(db, b.coachId)).rejects.toThrow(CoachSuspendedError);
    expect((await listCoaches(db)).map((c) => [c.slug, c.status, c.clients])).toEqual([
      ["demo", "active", 1],
      ["other", "suspended", 1],
    ]);

    // Both 08:00 reminders are due; only A's is claimed (it's then skipped: that client never consented).
    app.clock.now = zonedTimeToUtc("2026-10-18", "08:01", IL);
    const scheduler = new ReminderScheduler({ db, cfg: app.cfg, apiFor, now: () => app.clock.now });
    expect(await scheduler.tick()).toEqual({ sent: 0, skipped: 1 });
    const reminderB = async () => (await db.select().from(reminders).where(eq(reminders.coachId, b.coachId)))[0]!;
    expect((await reminderB()).nextRunAt!.toISOString()).toBe(zonedTimeToUtc("2026-10-18", "08:00", IL).toISOString());

    expect(await resumeCoach(db, b.coachId, "test", app.cfg, app.clock.now)).toBe(true);
    expect((await reminderB()).nextRunAt!.toISOString()).toBe(zonedTimeToUtc("2026-10-25", "08:00", IL).toISOString());
    expect((await authenticate(db, "coach-b@example.com", "a-long-password-1")).ok).toBe(true);
    expect((await openTenant(db, b.coachId)).status).toBe("active");
    const actions = (await listPlatformAudit(db)).filter((r) => r.coachId === b.coachId).map((r) => r.action);
    expect(actions.sort()).toEqual(["coach_resumed", "coach_suspended"]);
  });

  it("answers a suspended coach's client once with a fixed notice, without AI, and ignores strangers", async () => {
    await suspendCoach(db, b.coachId, "test", app.clock.now);
    const llmCalls = app.llm.requests.length;
    expect(await receive(msg("pn-b", PHONE, "היי, יש תפריט חדש?"), msg("pn-b", "972509999999", "מי זה?"))).toMatchObject({
      queued: 1,
      suspended: 1,
    });
    await worker.tick();

    const notice = suspendedNoticeText(b.coachName);
    expect(textsB()).toEqual([expect.objectContaining({ to: PHONE, body: notice })]);
    expect(app.llm.requests.length).toBe(llmCalls);
    // The client's message wasn't kept, the coach will see the notice in the history, the stranger left no trace.
    const done = await db.select().from(inboundMessages).where(and(eq(inboundMessages.coachId, b.coachId), eq(inboundMessages.status, "done")));
    expect(done.map((m) => m.bodyEnc)).toEqual([null]);
    expect((await listChatMessages(db, b, clientB.id)).at(-1)).toMatchObject({ sender: "system", body: notice });
    expect(await findClientByPhone(db, b, "972509999999")).toBeUndefined();

    // Same suspension: no second notice.
    expect(await receive(msg("pn-b", PHONE, "הלו?"))).toMatchObject({ queued: 0, suspended: 1 });
    await worker.tick();
    expect(textsB()).toHaveLength(1);

    // A later suspension gets a new one.
    await resumeCoach(db, b.coachId, "test", app.cfg, app.clock.now);
    app.clock.now = new Date(app.clock.now.getTime() + 3600_000);
    await suspendCoach(db, b.coachId, "test", app.clock.now);
    expect(await receive(msg("pn-b", PHONE, "שוב אני"))).toMatchObject({ queued: 1 });
    await worker.tick();
    expect(textsB()).toHaveLength(2);
  });

  it("deletes a suspended coach completely, keeps a platform record, and frees the number", async () => {
    await expect(deleteCoach(db, b.coachId, { actor: "test", confirmSlug: "other" })).rejects.toThrow(/להשעות/);
    await suspendCoach(db, b.coachId, "test", app.clock.now);
    await expect(deleteCoach(db, b.coachId, { actor: "test", confirmSlug: "demo" })).rejects.toThrow(/האישור/);

    const tenantTables = (await publicTables(db)).map((t) => t.name).filter((n) => !PLATFORM_TABLES.includes(n));
    const rowsOf = async (coachId: string) => {
      const counts: Record<string, number> = {};
      for (const n of tenantTables) counts[n] = await countAs(db, null, n, `${ownerColumn(n)} = '${coachId}'`);
      return counts;
    };
    const before = { a: await rowsOf(a.coachId), b: await rowsOf(b.coachId) };
    // turn_jobs and sessions were already cleared by the suspension.
    expect(Object.entries(before.b).filter(([, n]) => n === 0).map(([name]) => name)).toEqual(["sessions", "turn_jobs"]);
    const [profile] = await db.select().from(clientProfiles).where(eq(clientProfiles.clientId, clientB.id));

    const summary = await deleteCoach(db, b.coachId, { actor: "test", confirmSlug: "other" });
    expect(summary).toMatchObject({ slug: "other", name: "מאמנת אחרת", clients: 1 });
    expect(summary.usage).toEqual([expect.objectContaining({ month: expect.stringMatching(/^\d{4}-\d{2}$/), calls: 1, inputTokens: 10 })]);
    expect(summary.messages.length).toBeGreaterThan(0);

    // Every row is gone, and the other coach is untouched.
    expect(Object.values(await rowsOf(b.coachId)).every((n) => n === 0)).toBe(true);
    expect(await rowsOf(a.coachId)).toEqual(before.a);
    // The wrapped key went with the coach row: the coach can't be opened, and a saved copy of the
    // ciphertext doesn't open with any key that's left.
    await expect(openTenant(db, b.coachId, { allowSuspended: true })).rejects.toThrow(TenantNotFoundError);
    expect(() => decryptJson(a, profile!.dataEnc)).toThrow();

    const record = (await listPlatformAudit(db)).find((r) => r.action === "coach_deleted");
    expect(record).toMatchObject({ actor: "test", coachId: b.coachId, coachSlug: "other", meta: expect.objectContaining({ clients: 1 }) });

    // The number is free: a webhook batch mixing it with a live number still goes through, and it can be reassigned.
    expect(await receive(msg("pn-b", PHONE, "היי"), msg("pn-a", PHONE, "היי"))).toMatchObject({ unknownNumber: 1, queued: 1 });
    await connectWhatsAppNumber(db, a, { phoneNumberId: "pn-b" });
  });
});
