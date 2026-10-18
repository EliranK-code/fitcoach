import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alerts, chatMessages, inboundMessages, rateLimits, turnJobs, usageEvents } from "../src/db/schema";
import { listCoaches, resumeCoach, suspendCoach } from "../src/platform";
import { budgetStatus, estimateCostMicros, formatUsd } from "../src/pricing";
import { hitRateLimit, purgeRateLimits } from "../src/ratelimit";
import { deleteClientData } from "../src/privacy";
import { findClientByPhone, updateClient } from "../src/repos/clients";
import { listAlerts } from "../src/repos/ops";
import { coachCapUsd, platformDaySpendMicros, spendBlock, spendBlockMessage, spendCaps } from "../src/spend";
import { createCoach, openTenant, updateCoach, type TenantContext } from "../src/tenancy";
import { monthUsage } from "../src/usage";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { createDryRunApi } from "../src/whatsapp/api";
import { CLIENT_DAY_WINDOW_MS, CLIENT_RATE_WINDOW_MS, enqueueInbound } from "../src/whatsapp/inbox";
import { sendTemplateMessage } from "../src/whatsapp/outbound";
import type { InboundWaMessage } from "../src/whatsapp/webhook";
import { InboundWorker } from "../src/whatsapp/worker";
import { createTestApp, message, openToEveryone, testConfig, text, type TestApp } from "./helpers";

describe("pricing", () => {
  it("prices Claude tokens per model, cache reads and writes included", () => {
    // $4 / $20 per MTok, cache writes $5, cache reads $0.20: micro-dollars per token are the same numbers.
    const usage = { kind: "chat", model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000 };
    expect(estimateCostMicros(usage)).toBe(4000 + 10_000 + 2000 + 10_000);
    expect(estimateCostMicros({ ...usage, model: "claude-sonnet-5-5" })).toBe(2000 + 5000 + 2000 + 5000);
    // An unknown model is priced like Claude Opus 5, never as free.
    expect(estimateCostMicros({ kind: "chat", model: "claude-next", inputTokens: 1000 })).toBe(5000);
    expect(estimateCostMicros({ kind: "embedding", model: "text-embedding-3-small", inputTokens: 1_000_000 })).toBe(20_000);
  });

  it("charges WhatsApp templates at the configured price and service messages at nothing", () => {
    expect(estimateCostMicros({ kind: "template", model: "whatsapp", quantity: 2 }, { whatsappTemplateUsd: 0.05 })).toBe(100_000);
    expect(estimateCostMicros({ kind: "message_out", model: "whatsapp", quantity: 9 }, { whatsappTemplateUsd: 0.05 })).toBe(0);
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  it("reports the soft budget at 80% and 100%", () => {
    expect(budgetStatus(5_000_000, null)).toEqual({ level: "none", percent: null });
    expect(budgetStatus(7_900_000, 10)).toEqual({ level: "ok", percent: 79 });
    expect(budgetStatus(8_000_000, 10)).toEqual({ level: "warn", percent: 80 });
    expect(budgetStatus(12_000_000, 10)).toEqual({ level: "over", percent: 120 });
  });
});

describe("usage metering and limits", () => {
  let app: TestApp;
  let t: TenantContext;
  let api: ReturnType<typeof createDryRunApi>;
  let worker: InboundWorker;
  let seq = 0;
  const FROM = "972508880000";

  const msg = (body: string, extra: Partial<InboundWaMessage> = {}): InboundWaMessage => ({
    phoneNumberId: "pn-u",
    from: FROM,
    id: `wamid.u.${++seq}`,
    timestamp: app.clock.now,
    kind: "text",
    text: body,
    ...extra,
  });

  beforeEach(async () => {
    app = await createTestApp();
    t = await openToEveryone(app.handle.db, await app.tenant());
    await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: "pn-u" });
    api = createDryRunApi("pn-u", () => {});
    worker = new InboundWorker({ db: app.handle.db, cfg: app.cfg, engine: app.engine, apiFor: async () => api, now: () => app.clock.now });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  const deliver = async (...msgs: InboundWaMessage[]) => {
    await enqueueInbound(app.handle.db, msgs, { debounceMs: 0, now: app.clock.now });
    return worker.tick();
  };

  it("counts messages in and out, prices model calls, and keeps usage after a client is deleted", async () => {
    const db = app.handle.db;
    await deliver(msg("היי"));
    app.llm.push(message([text("היי! איך קוראים לך?")]));
    await deliver(msg("מאשר/ת ✅", { kind: "button", buttonId: "consent_yes" }));
    const client = (await findClientByPhone(db, t, FROM))!;
    await sendTemplateMessage(db, t, client, api, { name: "checkin", languageCode: "he", bodyParams: ["דנה"] }, { actor: "test" });

    const usage = await monthUsage(db, t, app.clock.now);
    expect(usage).toMatchObject({ messagesIn: 2, messagesOut: 2, templates: 1 });
    // FakeLlm reports 1,200 input and 80 output tokens: 1200 × $4 + 80 × $20 per MTok.
    expect(usage.byKind.find((k) => k.kind === "chat")).toMatchObject({ events: 1, tokens: 1280, costMicros: 6400 });
    expect(usage.costMicros).toBe(6400); // service messages are free; the template price defaults to 0
    const [summary] = (await listCoaches(db)).filter((c) => c.id === t.coachId);
    expect(summary).toMatchObject({ monthCostMicros: 6400, budgetUsd: null });

    t = await updateCoach(db, t, { settings: { monthlyBudgetUsd: 25 } });
    expect((await listCoaches(db)).find((c) => c.id === t.coachId)?.budgetUsd).toBe(25);
    // An admin can still change a suspended coach's budget.
    await suspendCoach(db, t.coachId, "test", app.clock.now);
    const suspended = await openTenant(db, t.coachId, { allowSuspended: true });
    expect((await updateCoach(db, suspended, { settings: { monthlyBudgetUsd: 40 } })).settings.monthlyBudgetUsd).toBe(40);
    await resumeCoach(db, t.coachId, "test", app.cfg, app.clock.now);
    t = await openTenant(db, t.coachId);

    // Billing data outlives the client.
    await deleteClientData(db, t, client.id, "test");
    expect((await monthUsage(db, t, app.clock.now)).costMicros).toBe(6400);
    expect(await db.select().from(usageEvents).where(eq(usageEvents.kind, "message_in"))).toHaveLength(2);
  });

  it("counts rate-limit hits atomically per key and window", async () => {
    const db = app.handle.db;
    const now = new Date("2026-10-17T10:00:00Z");
    expect(await hitRateLimit(db, "k", 60_000, now)).toBe(1);
    expect(await hitRateLimit(db, "k", 60_000, now)).toBe(2);
    expect(await hitRateLimit(db, "other", 60_000, now)).toBe(1);
    const burst = await Promise.all(Array.from({ length: 10 }, () => hitRateLimit(db, "k", 60_000, now)));
    expect(burst.sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // A new window starts over.
    expect(await hitRateLimit(db, "k", 60_000, new Date(now.getTime() + 60_000))).toBe(1);
    expect(await purgeRateLimits(db, new Date(now.getTime() + 30_000))).toBe(1); // "other" is stale, "k" just restarted
    expect((await db.select().from(rateLimits)).map((r) => r.key)).toEqual(["k"]);
  });

  it("stops answering a client over the hourly limit, keeps the messages for the coach, and alerts once", async () => {
    const db = app.handle.db;
    const limited = (...msgs: InboundWaMessage[]) => enqueueInbound(db, msgs, { debounceMs: 0, now: app.clock.now, clientHourlyLimit: 3 });
    expect(await limited(msg("1"), msg("2"), msg("3"))).toMatchObject({ queued: 3, rateLimited: 0 });
    const client = (await findClientByPhone(db, t, FROM))!;
    await updateClient(db, t, client.id, { consentStatus: "granted", consentAt: app.clock.now });

    const fourth = msg("4");
    expect(await limited(fourth)).toMatchObject({ queued: 0, rateLimited: 1 });
    expect(await limited(fourth)).toMatchObject({ duplicates: 1, rateLimited: 0 }); // Meta redelivery isn't counted twice
    expect(await limited(msg("5"))).toMatchObject({ rateLimited: 1 });

    const held = await db.select().from(inboundMessages).where(eq(inboundMessages.status, "rate_limited"));
    expect(held.map((m) => m.bodyEnc)).toEqual([null, null]);
    const kept = await db.select().from(chatMessages).where(and(eq(chatMessages.clientId, client.id), eq(chatMessages.botSeen, false)));
    expect(kept).toHaveLength(2); // in the conversation for the coach, and context for the bot's next turn
    expect(await db.select().from(alerts).where(eq(alerts.type, "rate_limited"))).toHaveLength(1);
    expect((await monthUsage(db, t, app.clock.now)).messagesIn).toBe(5);

    // The queued turn still covers the first three; after the window the bot answers again.
    expect(await db.select().from(turnJobs)).toHaveLength(1);
    app.clock.now = new Date(app.clock.now.getTime() + CLIENT_RATE_WINDOW_MS + 1000);
    expect(await limited(msg("6"))).toMatchObject({ queued: 1, rateLimited: 0 });
  });

  it("also holds a client over the daily limit, even when each hour stays under the hourly one", async () => {
    const db = app.handle.db;
    const start = app.clock.now.getTime();
    const receive = (...msgs: InboundWaMessage[]) =>
      enqueueInbound(db, msgs, { debounceMs: 0, now: app.clock.now, clientHourlyLimit: 30, clientDailyLimit: 4 });
    for (let i = 1; i <= 4; i++) {
      expect(await receive(msg(`m${i}`))).toMatchObject({ queued: 1 });
      app.clock.now = new Date(app.clock.now.getTime() + 2 * 3600_000);
    }
    expect(await receive(msg("m5"))).toMatchObject({ queued: 0, rateLimited: 1 });
    const [alert] = await listAlerts(db, t, { status: "open" });
    expect(alert).toMatchObject({ type: "rate_limited" });
    expect(alert!.summary).toContain("ביממה האחרונה");
    // A day after the window opened, the bot answers again.
    app.clock.now = new Date(start + CLIENT_DAY_WINDOW_MS + 1000);
    expect(await receive(msg("m6"))).toMatchObject({ queued: 1, rateLimited: 0 });
  });

  describe("spending caps", () => {
    const spend = (coachId: string, costMicros: number) =>
      app.handle.db.insert(usageEvents).values({ coachId, kind: "chat", model: "claude-opus-5-5", costMicros, createdAt: app.clock.now });

    it("holds every message once the coach's monthly cap is reached, alerts once a day, and resumes when an admin raises the cap", async () => {
      const db = app.handle.db;
      const caps = { coachMonthlyUsd: 10, platformDailyUsd: 0 };
      const receive = (...msgs: InboundWaMessage[]) => enqueueInbound(db, msgs, { debounceMs: 0, now: app.clock.now, spendCaps: caps });

      await spend(t.coachId, 9_990_000);
      expect(await spendBlock(db, t, caps, app.clock.now)).toBeNull();
      expect(await receive(msg("1"))).toMatchObject({ queued: 1, overCap: 0 });

      await spend(t.coachId, 20_000); // $10.01 this month
      expect(await spendBlock(db, t, caps, app.clock.now)).toMatchObject({ scope: "coach", capUsd: 10 });
      expect(await receive(msg("2"), msg("3"))).toMatchObject({ queued: 0, overCap: 2 });
      const held = await db.select().from(inboundMessages).where(eq(inboundMessages.status, "over_cap"));
      expect(held.map((m) => m.bodyEnc)).toEqual([null, null]);
      const capAlerts = (await listAlerts(db, t)).filter((a) => a.type === "spend_cap");
      expect(capAlerts).toHaveLength(1);
      expect(capAlerts[0]!.summary).toContain("$10");

      // A coach's own cap (set by an admin) wins over the platform default.
      t = await updateCoach(db, t, { settings: { monthlyCapUsd: 50 } });
      expect(coachCapUsd(t, caps)).toBe(50);
      expect(await receive(msg("4"))).toMatchObject({ queued: 1, overCap: 0 });
      // A new month starts from zero.
      app.clock.now = new Date("2026-11-01T00:00:01Z");
      expect(await spendBlock(db, await updateCoach(db, t, { settings: { monthlyCapUsd: 10 } }), caps, app.clock.now)).toBeNull();
    });

    it("holds messages for every coach once the platform's daily cap is reached, until the next UTC day", async () => {
      const db = app.handle.db;
      const caps = { coachMonthlyUsd: 0, platformDailyUsd: 5 };
      const other = await openTenant(db, await createCoach(db, { slug: "other", name: "מאמנת אחרת" }));
      await spend(other.coachId, 5_000_000); // another coach spent the whole day's cap
      expect(await platformDaySpendMicros(db, app.clock.now)).toBe(5_000_000);
      expect(await spendBlock(db, t, caps, app.clock.now)).toMatchObject({ scope: "platform", capUsd: 5 });
      expect(await enqueueInbound(db, [msg("היי")], { debounceMs: 0, now: app.clock.now, spendCaps: caps })).toMatchObject({ overCap: 1 });
      expect(spendBlockMessage({ scope: "platform", capUsd: 5, spentMicros: 5_000_000 })).toContain("מחר");

      app.clock.now = new Date("2026-10-17T00:00:01Z");
      expect(await spendBlock(db, t, caps, app.clock.now)).toBeNull();
      expect(await enqueueInbound(db, [msg("שוב")], { debounceMs: 0, now: app.clock.now, spendCaps: caps })).toMatchObject({ queued: 1 });
    });

    it("reads the caps from the config, and 0 turns a cap off", () => {
      const caps = spendCaps(testConfig({ COACH_MONTHLY_CAP_USD: "0", PLATFORM_DAILY_CAP_USD: "30" }));
      expect(caps).toEqual({ coachMonthlyUsd: 0, platformDailyUsd: 30 });
      expect(coachCapUsd({ settings: {} }, caps)).toBeNull();
      expect(coachCapUsd({ settings: { monthlyCapUsd: 80 } }, caps)).toBe(80);
      expect(spendCaps(testConfig({ COACH_MONTHLY_CAP_USD: "", PLATFORM_DAILY_CAP_USD: "" }))).toEqual({ coachMonthlyUsd: 200, platformDailyUsd: 100 });
    });
  });
});
