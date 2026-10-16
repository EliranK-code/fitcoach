import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCoachUser, createSession } from "../src/auth";
import { openDatabase, type Db, type DbHandle } from "../src/db/client";
import { TenantScopeError, withTenant } from "../src/db/scope";
import { alerts, auditLog, clients } from "../src/db/schema";
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
import { createCoach, openTenant, type TenantContext } from "../src/tenancy";
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

describe("row-level security", () => {
  let handle: DbHandle;
  let a: TenantContext;
  let b: TenantContext;
  let clientB: ClientRow;
  const cfg = testConfig();
  const now = new Date("2026-10-18T05:00:00Z");

  /** Writes at least one row into every tenant table, through the normal repositories. */
  async function populate(t: TenantContext, pnid: string): Promise<ClientRow> {
    const db = handle.db;
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

  async function publicTables(): Promise<{ name: string; rls: boolean; policies: number }[]> {
    return rows(
      await handle.db.execute(sql`
        select c.relname as name, c.relrowsecurity as rls,
               (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`),
    );
  }

  const ownerColumn = (table: string) => (table === "coaches" ? "id" : "coach_id");

  async function countAs(t: TenantContext | null, table: string, where = "true"): Promise<number> {
    const query = sql.raw(`select count(*)::int as n from "${table}" where ${where}`);
    const result = t ? await withTenant(handle.db, t, (db) => db.execute(query)) : await handle.db.execute(query);
    return rows<{ n: number }>(result)[0]!.n;
  }

  beforeAll(async () => {
    handle = await openDatabase({});
    const imported = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
    a = await openTenant(handle.db, imported.coachId);
    b = await addSecondCoach(handle.db, a);
    await populate(a, "pn-a");
    clientB = await populate(b, "pn-b");
  });

  afterAll(async () => {
    await handle.close();
  });

  it("is enabled, with a policy, on every table", async () => {
    const tables = await publicTables();
    expect(tables.length).toBe(24);
    expect(tables.filter((t) => !t.rls || t.policies === 0).map((t) => t.name)).toEqual([]);
  });

  it("shows a scoped query only its own coach's rows, in every table, even without a coach filter", async () => {
    for (const { name } of await publicTables()) {
      const col = ownerColumn(name);
      for (const [mine, theirs] of [
        [a, b],
        [b, a],
      ] as const) {
        const owned = await countAs(null, name, `${col} = '${mine.coachId}'`);
        expect(owned, `${name}: test data for ${mine.coachName}`).toBeGreaterThan(0);
        expect(await countAs(mine, name), name).toBe(owned);
        expect(await countAs(mine, name, `${col} = '${theirs.coachId}'`), name).toBe(0);
      }
    }
  });

  it("sees nothing as the tenant role without a coach", async () => {
    const n = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'app_tenant', true)`);
      return rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from clients`))[0]!.n;
    });
    expect(n).toBe(0);
    expect(await countAs(null, "clients")).toBe(2); // the role is transaction-local
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
    expect(await countAs(null, "alerts", `coach_id = '${b.coachId}'`)).toBe(1);
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
    expect(await countAs(null, "audit_log", `coach_id = '${a.coachId}'`)).toBeGreaterThan(0);
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
