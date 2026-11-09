import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE_DONE_TEXT } from "../src/consent";
import { chatMessages, clients, inboundMessages, turnJobs } from "../src/db/schema";
import { findClientByPhone, updateClient } from "../src/repos/clients";
import { listChatMessages } from "../src/repos/conversation";
import { listAlerts } from "../src/repos/ops";
import type { TenantContext } from "../src/tenancy";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { createDryRunApi, createGraphApi, WhatsAppApiError, type WhatsAppApi } from "../src/whatsapp/api";
import { applyStatuses, claimDueJobs, enqueueInbound, MAX_JOB_ATTEMPTS } from "../src/whatsapp/inbox";
import { OutsideServiceWindowError, sendCoachMessage, sendTemplateMessage } from "../src/whatsapp/outbound";
import { parseWebhook, verifySignature, verifySubscription, type InboundWaMessage } from "../src/whatsapp/webhook";
import { groupInbound, InboundWorker } from "../src/whatsapp/worker";
import { createTestApp, message, openToEveryone, text, type TestApp } from "./helpers";

const PNID = "pn-test-1";
const FROM = "972501234567";

describe("webhook security", () => {
  const secret = "app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "עולם" }));
  const sign = (b: Buffer, s = secret) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

  it("accepts only a correct HMAC over the raw body", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
    expect(verifySignature(body, sign(body, "other"), secret)).toBe(false);
    expect(verifySignature(Buffer.from(`${body} `), sign(body), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=abcd", secret)).toBe(false);
    expect(verifySignature(body, sign(body), "")).toBe(false);
  });

  it("answers the subscription handshake only with the right token", () => {
    const q = { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "123" };
    expect(verifySubscription(q, "tok")).toBe("123");
    expect(verifySubscription({ ...q, "hub.verify_token": "nope" }, "tok")).toBeNull();
    expect(verifySubscription(q, undefined)).toBeNull();
    expect(verifySubscription({ ...q, "hub.mode": "unsubscribe" }, "tok")).toBeNull();
  });
});

const payload = (value: Record<string, unknown>, phoneNumberId = PNID) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
});

describe("webhook parsing", () => {
  it("extracts text, buttons, media, reactions and statuses", () => {
    const { messages, statuses } = parseWebhook(
      payload({
        messages: [
          { from: FROM, id: "w1", timestamp: "1760600000", type: "text", text: { body: "היי" } },
          { from: FROM, id: "w2", timestamp: "1760600001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "consent_yes", title: "מאשר/ת ✅" } } },
          { from: FROM, id: "w3", timestamp: "1760600002", type: "button", button: { payload: "remind_ok", text: "אוקיי" } },
          { from: FROM, id: "w4", timestamp: "1760600003", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "ארוחת בוקר" } },
          { from: FROM, id: "w5", timestamp: "1760600004", type: "reaction", reaction: { emoji: "👍" } },
          { from: FROM, id: "w6", type: "weird_new_type" },
          { id: "missing-from", type: "text" },
        ],
        statuses: [{ id: "out1", status: "failed", timestamp: "1760600005", recipient_id: FROM, errors: [{ code: 131047, title: "Re-engagement message" }] }],
      }),
    );
    expect(messages.map((m) => m.kind)).toEqual(["text", "button", "button", "image", "reaction", "unsupported"]);
    expect(messages[0]).toMatchObject({ phoneNumberId: PNID, from: FROM, text: "היי", timestamp: new Date(1760600000_000) });
    expect(messages[1]).toMatchObject({ buttonId: "consent_yes" });
    expect(messages[3]).toMatchObject({ mediaId: "m1", text: "ארוחת בוקר" });
    expect(statuses[0]).toMatchObject({ messageId: "out1", status: "failed", errorCode: 131047 });
  });

  it("ignores payloads that aren't WhatsApp business events", () => {
    expect(parseWebhook({ object: "page", entry: [] })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook("nonsense")).toEqual({ messages: [], statuses: [] });
  });
});

describe("Graph API client", () => {
  it("posts the documented message shape with the bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createGraphApi({ token: "TOKEN", phoneNumberId: "123", version: "v23.0", fetch: fakeFetch });
    expect(await api.sendText(FROM, "שלום")).toEqual({ messageId: "wamid.1" });
    await api.sendButtons(FROM, "מאשר/ת?", [{ id: "yes", title: "כן, ברור שאני מאשר את זה" }]);
    await api.markRead("wamid.in", true);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: FROM,
      type: "text",
      text: { body: "שלום", preview_url: false },
    });
    const buttons = JSON.parse(String(calls[1]!.init.body));
    expect(buttons.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ status: "read", message_id: "wamid.in", typing_indicator: { type: "text" } });
  });

  it("retries server errors and surfaces Meta error codes", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      return n === 1
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ error: { message: "Re-engagement message", code: 131047 } }), { status: 400 });
    }) as unknown as typeof fetch;
    const api = createGraphApi({ token: "T", phoneNumberId: "1", version: "v23.0", fetch: flaky, retries: 2 });
    const err = await api.sendText(FROM, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect((err as WhatsAppApiError).code).toBe(131047);
    expect(n).toBe(2);
  });
});

describe("grouping", () => {
  const p = (kind: string, textValue = "", extra = {}) =>
    ({ id: `${Math.random()}`, externalId: `${Math.random()}`, kind, text: textValue, sentAt: new Date(), ...extra }) as never;

  it("merges consecutive texts; buttons and media stand alone", () => {
    const groups = groupInbound([p("text", "היי"), p("text", "יש לי שאלה"), p("button", "מאשר", { buttonId: "consent_yes" }), p("image", "צהריים"), p("text", "מה דעתך?")]);
    expect(groups.map((g) => g.messages.length)).toEqual([2, 1, 1, 1]);
    expect(groups[0]!.input.text).toBe("היי\nיש לי שאלה");
    expect(groups[1]!.input.buttonId).toBe("consent_yes");
    expect(groups[2]!.input.unsupported).toBe("image");
  });
});

describe("WhatsApp pipeline", () => {
  let app: TestApp;
  let t: TenantContext;
  let api: WhatsAppApi & { sent: { type: string; to?: string; body?: string; buttons?: unknown[] }[] };
  let worker: InboundWorker;
  let seq = 0;

  beforeEach(async () => {
    app = await createTestApp({ INBOUND_DEBOUNCE_MS: "4000", WORKER_CONCURRENCY: "4" });
    t = await openToEveryone(app.handle.db, await app.tenant());
    await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: PNID, displayPhone: "+972 3 000 0000" });
    api = createDryRunApi(PNID, () => {});
    worker = new InboundWorker({ db: app.handle.db, cfg: app.cfg, engine: app.engine, apiFor: async () => api, now: () => app.clock.now });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  const incoming = (body: string, extra: Partial<InboundWaMessage> = {}, from = FROM): InboundWaMessage => ({
    phoneNumberId: PNID,
    from,
    id: `wamid.in.${++seq}`,
    timestamp: app.clock.now,
    kind: "text",
    text: body,
    ...extra,
  });
  const receive = (...msgs: InboundWaMessage[]) => enqueueInbound(app.handle.db, msgs, { debounceMs: 4000, now: app.clock.now });
  const advance = (ms: number) => {
    app.clock.now = new Date(app.clock.now.getTime() + ms);
  };
  const runDue = async () => {
    advance(4001);
    return worker.tick();
  };
  const textsSent = () => api.sent.filter((e) => e.type === "text" || e.type === "buttons");
  const consent = async (from = FROM) => {
    await receive(incoming("היי", {}, from));
    await runDue();
    app.llm.push(message([text("היי! אני העוזר של גל. איך קוראים לך?")]));
    await receive(incoming("מאשר/ת ✅", { kind: "button", buttonId: "consent_yes" }, from));
    await runDue();
  };

  it("debounces, sends consent with buttons, and records delivery ids", async () => {
    const stats = await receive(incoming("היי"));
    expect(stats.queued).toBe(1);
    expect(await worker.tick()).toBe(0); // still inside the debounce window
    expect(await runDue()).toBe(1);
    expect(api.sent[0]).toMatchObject({ type: "read" });
    const consentMsg = textsSent()[0]!;
    expect(consentMsg.type).toBe("buttons");
    expect(consentMsg.to).toBe(FROM);
    expect(app.llm.requests).toHaveLength(0);
    const client = (await findClientByPhone(app.handle.db, t, FROM))!;
    const log = await listChatMessages(app.handle.db, t, client.id);
    expect(log.at(-1)).toMatchObject({ sender: "bot", status: "sent" });
    expect(await app.handle.db.select().from(turnJobs)).toHaveLength(0);
  });

  it("treats a consent button tap as consent and lets the model greet", async () => {
    await consent();
    expect(textsSent().at(-1)?.body).toContain("איך קוראים לך");
    expect((await findClientByPhone(app.handle.db, t, FROM))?.consentStatus).toBe("granted");
  });

  it("ignores redelivered webhooks", async () => {
    const msg = incoming("היי");
    expect((await receive(msg)).queued).toBe(1);
    expect((await receive(msg)).duplicates).toBe(1);
    expect(await app.handle.db.select().from(inboundMessages)).toHaveLength(1);
  });

  it("ignores numbers that aren't connected to a coach", async () => {
    const stats = await enqueueInbound(app.handle.db, [{ ...incoming("היי"), phoneNumberId: "unknown" }], { debounceMs: 0 });
    expect(stats.unknownNumber).toBe(1);
  });

  it("answers a burst of messages in a single turn", async () => {
    await consent();
    const before = app.llm.chatRequests.length;
    app.llm.push(message([text("שאלות מעולות! בוא נתחיל מהראשונה.")]));
    await receive(incoming("רגע"));
    advance(1500);
    await receive(incoming("יש לי שתי שאלות"));
    advance(1500);
    expect(await worker.tick()).toBe(0); // the second message pushed the turn back
    await runDue();
    expect(app.llm.chatRequests.length).toBe(before + 1);
    const lastUser = app.llm.chatRequests.at(-1)!.messages.findLast((m) => m.role === "user") as { content: { text: string }[] };
    expect(lastUser.content[0]!.text).toMatch(/רגע\nיש לי שתי שאלות$/);
  });

  it("serializes each client but runs different clients in parallel", async () => {
    await receive(incoming("היי", {}, "972500000001"), incoming("היי", {}, "972500000002"));
    expect(await runDue()).toBe(2);
    expect(textsSent().map((m) => m.to).sort()).toEqual(["972500000001", "972500000002"]);
  });

  it("applies delivery statuses without going backwards", async () => {
    await receive(incoming("היי"));
    await runDue();
    const client = (await findClientByPhone(app.handle.db, t, FROM))!;
    const outbound = (await app.handle.db.select().from(chatMessages)).find((m) => m.direction === "out")!;
    const status = (s: string) => ({ phoneNumberId: PNID, messageId: outbound.externalId!, status: s, recipient: FROM, timestamp: new Date() });
    await applyStatuses(app.handle.db, [status("read")]);
    await applyStatuses(app.handle.db, [status("delivered")]);
    expect((await listChatMessages(app.handle.db, t, client.id)).at(-1)?.status).toBe("read");
  });

  it("answers media it can't read yet without calling the model", async () => {
    await consent();
    const before = app.llm.requests.length;
    await receive(incoming("", { kind: "video", mediaId: "m1" }));
    await runDue();
    expect(app.llm.requests.length).toBe(before);
    expect(textsSent().at(-1)?.body).toContain("can't read this kind");
  });

  it("human takeover: silent while paused, then the bot gets the record of what the coach said", async () => {
    await consent();
    const db = app.handle.db;
    const client = (await findClientByPhone(db, t, FROM))!;
    await updateClient(db, t, client.id, { botPaused: true });
    const sentBefore = textsSent().length;

    await receive(incoming("אפשר לדבר עם גל עצמו?"));
    await runDue();
    expect(textsSent().length).toBe(sentBefore);
    expect((await listAlerts(db, t, { status: "open" })).some((a) => a.type === "paused_message")).toBe(true);

    await sendCoachMessage(db, t, (await findClientByPhone(db, t, FROM))!, api, "היי, כאן גל! נקבע שיחה ביום ראשון ב-10.", { now: app.clock.now, actor: "test" });
    expect(textsSent().at(-1)?.body).toContain("כאן גל");

    await updateClient(db, t, client.id, { botPaused: false });
    app.llm.push(message([text("מעולה, נתראה ביום ראשון!")]));
    await receive(incoming("תודה!"));
    await runDue();
    const req = app.llm.chatRequests.at(-1)!;
    const note = String(req.messages.at(-1)!.content);
    expect(req.messages.at(-1)!.role).toBe("system");
    expect(note).toContain("<coach_conversation>");
    expect(note).toContain("Client: אפשר לדבר עם גל עצמו?");
    expect(note).toContain("Coach: היי, כאן גל!");

    // The record is delivered once.
    app.llm.push(message([text("בכיף")]));
    await receive(incoming("עוד משהו"));
    await runDue();
    expect(String(app.llm.chatRequests.at(-1)!.messages.at(-1)!.content)).not.toContain("coach_conversation");
  });

  it("enforces the 24-hour window for free-form coach messages, but allows templates", async () => {
    await consent();
    advance(25 * 3600_000);
    const client = (await findClientByPhone(app.handle.db, t, FROM))!;
    await expect(sendCoachMessage(app.handle.db, t, client, api, "מה נשמע?", { now: app.clock.now, actor: "test" })).rejects.toBeInstanceOf(
      OutsideServiceWindowError,
    );
    await sendTemplateMessage(app.handle.db, t, client, api, { name: "checkin_reminder", languageCode: "he", bodyParams: ["דנה"] }, { actor: "test" });
    expect(api.sent.at(-1)).toMatchObject({ type: "template", template: { name: "checkin_reminder", bodyParams: ["דנה"] } });
  });

  it("deletes a client on request and confirms over WhatsApp", async () => {
    await consent();
    await receive(incoming("מחק את המידע שלי"));
    await runDue();
    await receive(incoming("מחק לצמיתות"));
    await runDue();
    expect(textsSent().at(-1)?.body).toBe(DELETE_DONE_TEXT);
    expect(await app.handle.db.select().from(clients)).toHaveLength(0);
    expect(await app.handle.db.select().from(inboundMessages)).toHaveLength(0);
    expect(await app.handle.db.select().from(turnJobs)).toHaveLength(0);
  });

  it("retries failed jobs with backoff and alerts the coach after giving up", async () => {
    let calls = 0;
    const failing = new InboundWorker({
      db: app.handle.db,
      cfg: app.cfg,
      engine: app.engine,
      apiFor: async () => {
        calls++;
        throw new Error("Meta is down");
      },
      now: () => app.clock.now,
    });
    await receive(incoming("היי"));
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      advance(10 * 60_000);
      await failing.tick();
    }
    expect(calls).toBe(MAX_JOB_ATTEMPTS);
    expect(await app.handle.db.select().from(turnJobs)).toHaveLength(0);
    const alerts = await listAlerts(app.handle.db, t, { status: "open" });
    expect(alerts.some((a) => a.type === "bot_error" && a.summary.includes("Meta is down"))).toBe(true);
  });

  it("does not hand the same job to two workers", async () => {
    await receive(incoming("היי"));
    advance(4001);
    const a = await claimDueJobs(app.handle.db, { now: app.clock.now, limit: 5, leaseMs: 60_000 });
    const b = await claimDueJobs(app.handle.db, { now: app.clock.now, limit: 5, leaseMs: 60_000 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

describe("account routing", () => {
  it("refuses to connect a number that belongs to another coach", async () => {
    const app = await createTestApp();
    try {
      const t = await app.tenant();
      await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: "shared" });
      const { createCoach, openTenant } = await import("../src/tenancy");
      const other = await openTenant(app.handle.db, await createCoach(app.handle.db, { slug: "x", name: "X" }));
      await expect(connectWhatsAppNumber(app.handle.db, other, { phoneNumberId: "shared" })).rejects.toThrow(/another coach/);
    } finally {
      await app.handle.close();
    }
  });
});
