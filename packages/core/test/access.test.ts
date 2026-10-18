import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessNoticeText, addApprovedClient, approveClient, ClientAccessError, parseClientPhone, revokeClientAccess } from "../src/access";
import { decryptText } from "../src/crypto";
import { chatMessages } from "../src/db/schema";
import { sendReminder } from "../src/reminders/scheduler";
import { findClientByPhone } from "../src/repos/clients";
import { listAlerts } from "../src/repos/ops";
import { updateCoach, type TenantContext } from "../src/tenancy";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { createDryRunApi } from "../src/whatsapp/api";
import { enqueueInbound } from "../src/whatsapp/inbox";
import { deliverTurn } from "../src/whatsapp/outbound";
import type { InboundWaMessage } from "../src/whatsapp/webhook";
import { InboundWorker } from "../src/whatsapp/worker";
import { createTestApp, message, text, type TestApp } from "./helpers";

// "Approved only" (the default): the bot answers on WhatsApp only numbers the coach approved.

const PNID = "pn-access";
const STRANGER = "972509990000";

describe("client access", () => {
  let app: TestApp;
  let t: TenantContext;
  let api: ReturnType<typeof createDryRunApi>;
  let worker: InboundWorker;
  let seq = 0;

  beforeEach(async () => {
    app = await createTestApp({ INBOUND_DEBOUNCE_MS: "0" });
    t = await app.tenant();
    await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: PNID });
    api = createDryRunApi(PNID, () => {});
    worker = new InboundWorker({ db: app.handle.db, cfg: app.cfg, engine: app.engine, apiFor: async () => api, now: () => app.clock.now });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  const send = async (from: string, body: string, extra: Partial<InboundWaMessage> = {}) => {
    const msg: InboundWaMessage = { phoneNumberId: PNID, from, id: `wamid.acc.${++seq}`, timestamp: app.clock.now, kind: "text", text: body, ...extra };
    await enqueueInbound(app.handle.db, [msg], { debounceMs: 0, now: app.clock.now });
    await worker.tick();
  };
  const textsTo = (to: string) => api.sent.filter((e) => (e.type === "text" || e.type === "buttons") && e.to === to);
  const advanceHours = (h: number) => {
    app.clock.now = new Date(app.clock.now.getTime() + h * 3600_000);
  };

  it("answers a number the coach never approved with one notice a day, opens a join request, and never calls the AI", async () => {
    const db = app.handle.db;
    await send(STRANGER, "היי, אפשר תפריט?");
    expect(textsTo(STRANGER).map((e) => e.body)).toEqual([accessNoticeText(t.coachName)]);
    const client = (await findClientByPhone(db, t, STRANGER))!;
    expect(client.approvedAt).toBeNull();
    expect(app.llm.requests).toHaveLength(0);
    // Nothing the stranger wrote is stored.
    const rows = await db.select().from(chatMessages);
    expect(rows.filter((m) => m.direction === "in").map((m) => m.bodyEnc)).toEqual([null]);
    const requests = (await listAlerts(db, t, { status: "open" })).filter((a) => a.type === "join_request");
    expect(requests).toHaveLength(1);

    // More messages the same day: silence, and still a single request.
    await send(STRANGER, "?");
    await send(STRANGER, "הלו");
    expect(textsTo(STRANGER)).toHaveLength(1);
    expect((await listAlerts(db, t, { status: "open" })).filter((a) => a.type === "join_request")).toHaveLength(1);
    // A day later, one more notice.
    advanceHours(25);
    await send(STRANGER, "היי שוב");
    expect(textsTo(STRANGER)).toHaveLength(2);
    expect(app.llm.requests).toHaveLength(0);
  });

  it("sends the consent notice the moment the coach approves, and the bot works from there", async () => {
    const db = app.handle.db;
    await send(STRANGER, "היי");
    let client = (await findClientByPhone(db, t, STRANGER))!;

    client = await approveClient(db, t, client, "user:coach@example.com", app.clock.now);
    expect(client.approvedAt).not.toBeNull();
    expect((await listAlerts(db, t, { status: "open" })).filter((a) => a.type === "join_request")).toHaveLength(0);
    // What the dashboard does right after approving, inside the 24-hour window.
    await deliverTurn(db, t, client, api, await app.engine.promptConsent(t.coachId, client.id), app.clock.now);
    expect(textsTo(STRANGER).at(-1)).toMatchObject({ type: "buttons" });

    app.llm.push(message([text("היי! איך קוראים לך?")]));
    await send(STRANGER, "מאשר/ת ✅", { kind: "button", buttonId: "consent_yes" });
    expect(textsTo(STRANGER).at(-1)?.body).toContain("איך קוראים לך");
    expect((await findClientByPhone(db, t, STRANGER))?.consentStatus).toBe("granted");
  });

  it("lets the coach add a number in advance, in any common format", async () => {
    const db = app.handle.db;
    const { client, created } = await addApprovedClient(db, t, "050-123 4567", "user:coach@example.com");
    expect(created).toBe(true);
    expect(decryptText(t, client.phoneEnc)).toBe("972501234567"); // the form WhatsApp sends to
    expect((await addApprovedClient(db, t, "+972501234567", "user:coach@example.com")).created).toBe(false);

    // Their first message gets the consent notice, not the "not approved" one.
    await send("972501234567", "היי");
    expect(textsTo("972501234567")).toHaveLength(1);
    expect(textsTo("972501234567")[0]).toMatchObject({ type: "buttons" });
    expect(textsTo("972501234567")[0]!.body).not.toBe(accessNoticeText(t.coachName));
  });

  it("refuses something that isn't a phone number", () => {
    expect(() => parseClientPhone("abc")).toThrow(ClientAccessError);
    expect(() => parseClientPhone("123")).toThrow(ClientAccessError);
    expect(parseClientPhone("00972-50-1234567")).toBe("972501234567");
  });

  it("stops the bot and the reminders for a client whose access the coach removed, without a new join request", async () => {
    const db = app.handle.db;
    await addApprovedClient(db, t, STRANGER, "user:coach@example.com");
    app.llm.push(message([text("היי! איך קוראים לך?")]));
    await send(STRANGER, "היי");
    await send(STRANGER, "מאשר/ת ✅", { kind: "button", buttonId: "consent_yes" });
    let client = (await findClientByPhone(db, t, STRANGER))!;
    expect(client.consentStatus).toBe("granted");
    const before = app.llm.requests.length;

    client = await revokeClientAccess(db, t, client.id, "user:coach@example.com", app.clock.now);
    expect(await sendReminder(db, t, client, "weigh_in", api, app.clock.now)).toBe("skipped");
    await send(STRANGER, "מה התפריט שלי היום?");
    expect(textsTo(STRANGER).at(-1)?.body).toBe(accessNoticeText(t.coachName));
    expect(app.llm.requests.length).toBe(before);
    expect((await listAlerts(db, t, { status: "open" })).filter((a) => a.type === "join_request")).toHaveLength(0);

    // Restoring access: back to normal, consent already given.
    await approveClient(db, t, client, "user:coach@example.com");
    app.llm.push(message([text("הנה התפריט להיום")]));
    await send(STRANGER, "מה התפריט שלי היום?");
    expect(textsTo(STRANGER).at(-1)?.body).toBe("הנה התפריט להיום");
  });

  it("in open mode approves a new number on its first message, as before", async () => {
    t = await updateCoach(app.handle.db, t, { settings: { clientAccess: "open" } });
    await send(STRANGER, "היי");
    expect((await findClientByPhone(app.handle.db, t, STRANGER))?.approvedAt).not.toBeNull();
    expect(textsTo(STRANGER)[0]).toMatchObject({ type: "buttons" });
  });

  it("always lets terminal and playground clients through", async () => {
    const res = await app.engine.handleInbound({ coachId: t.coachId, phone: "playground:user", text: "היי", channel: "playground", isTest: true });
    expect(res.buttons).toBeDefined(); // the consent notice, not the access notice
    expect((await findClientByPhone(app.handle.db, t, "playground:user"))?.approvedAt).not.toBeNull();
  });
});
