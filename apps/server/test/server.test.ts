import { createHmac } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDeliveryStatus, connectWhatsAppNumber, createLogger, logChatMessage, schema, WEBHOOK_MAX_BYTES, type AppConfig, type Db } from "@fitcoach/core";
import { createTestApp, testConfig, type TestApp } from "../../../packages/core/test/helpers";
import { buildServer } from "../src/app";

const SECRET = "test-app-secret";
let app: TestApp;
let server: ReturnType<typeof buildServer>;

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const textPayload = (id: string, body: string) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "pn-1" },
              messages: [{ from: "972501234567", id, timestamp: "1760600000", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  });

beforeAll(async () => {
  app = await createTestApp();
  await connectWhatsAppNumber(app.handle.db, await app.tenant(), { phoneNumberId: "pn-1" });
  server = buildServer({
    db: app.handle.db,
    cfg: testConfig({ WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: "verify-me", INBOUND_DEBOUNCE_MS: "0" }),
  });
});

afterAll(async () => {
  await server.close();
  await app.handle.close();
});

describe("GET /webhook (subscription handshake)", () => {
  it("echoes the challenge for the right token", async () => {
    const res = await server.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("42");
  });

  it("refuses a wrong token", async () => {
    const res = await server.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /webhook", () => {
  it("rejects unsigned or wrongly signed requests and stores nothing", async () => {
    const body = textPayload("wamid.bad", "היי");
    const unsigned = await server.inject({ method: "POST", url: "/webhook", payload: body, headers: { "content-type": "application/json" } });
    const wrong = await server.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, "attacker") },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(await app.handle.db.select().from(schema.inboundMessages)).toHaveLength(0);
  });

  it("accepts a signed message and queues it", async () => {
    const body = textPayload("wamid.good", "היי");
    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    expect(res.statusCode).toBe(200);
    expect(await app.handle.db.select().from(schema.inboundMessages)).toHaveLength(1);
    expect(await app.handle.db.select().from(schema.turnJobs)).toHaveLength(1);
  });

  it("rejects malformed JSON even when signed", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      payload: "{not json",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign("{not json") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("applies delivery status updates", async () => {
    const t = await app.tenant();
    const [client] = await app.handle.db.select().from(schema.clients);
    await logChatMessage(app.handle.db, t, { clientId: client!.id, direction: "out", sender: "bot", body: "x", externalId: "wamid.out.1", status: "sent" });
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "w", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-1" }, statuses: [{ id: "wamid.out.1", status: "delivered", timestamp: "1760600001" }] } }] }],
    });
    const res = await server.inject({ method: "POST", url: "/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    expect(res.statusCode).toBe(200);
    const rows = await app.handle.db.select().from(schema.chatMessages);
    expect(rows.find((r) => r.externalId === "wamid.out.1")?.status).toBe("delivered");
    expect(await applyDeliveryStatus(app.handle.db, "unknown", "read")).toBe(false);
  });

  it("fails closed when the app secret isn't configured", async () => {
    const open = buildServer({ db: app.handle.db, cfg: testConfig({ WHATSAPP_APP_SECRET: "" }) });
    const body = textPayload("wamid.x", "היי");
    const res = await open.inject({ method: "POST", url: "/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    expect(res.statusCode).toBe(500);
    await open.close();
  });
});

describe("errors", () => {
  // Fake values that must never reach the client or the log.
  const PHONE = "972501234567";
  const NOTE = "fake private note";
  const failingDb = () =>
    new Proxy({} as Db, {
      get() {
        throw new DrizzleQueryError("insert into whatsapp_inbox (phone_hash, body_enc) values ($1, $2)", [PHONE, NOTE], new Error("connection reset"));
      },
    });
  const captured = () => {
    const lines: string[] = [];
    return { logger: createLogger({ write: (s: string) => void lines.push(s) }, "info"), text: () => lines.join("") };
  };

  it("answers an internal error with a generic 500 and logs it without query parameters", async () => {
    const log = captured();
    const broken = buildServer({ db: failingDb(), cfg: testConfig({ WHATSAPP_APP_SECRET: SECRET }), logger: log.logger });
    const body = textPayload("wamid.err", "my knee hurts");
    const res = await broken.inject({ method: "POST", url: "/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    await broken.close();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal Server Error" });
    for (const leak of ["insert into", "whatsapp_inbox", PHONE, NOTE, "connection reset"]) expect(res.body).not.toContain(leak);

    const out = log.text();
    expect(out).toContain("request failed");
    expect(out).toContain('"route":"/webhook"');
    expect(out).toContain("params: [redacted]");
    for (const leak of [PHONE, NOTE, "my knee hurts"]) expect(out).not.toContain(leak);
  });

  it("never logs the URL, which carries the verify token", async () => {
    const log = captured();
    const cfg = new Proxy(testConfig(), {
      get(target, prop) {
        if (prop === "WHATSAPP_VERIFY_TOKEN") throw new Error("config unavailable");
        return target[prop as keyof AppConfig];
      },
    });
    const broken = buildServer({ db: app.handle.db, cfg, logger: log.logger });
    const res = await broken.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=fake-verify-token-77&hub.challenge=1" });
    await broken.close();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal Server Error" });
    expect(res.body).not.toContain("config unavailable");
    expect(log.text()).toContain("config unavailable");
    expect(log.text()).not.toContain("fake-verify-token-77");
  });

  it("answers client errors with the status text only", async () => {
    const big = await server.inject({ method: "POST", url: "/webhook", payload: "x".repeat(WEBHOOK_MAX_BYTES + 1), headers: { "content-type": "application/json" } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: "Payload Too Large" });

    const wrongType = await server.inject({ method: "POST", url: "/webhook", payload: "<xml/>", headers: { "content-type": "application/xml" } });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toEqual({ error: "Unsupported Media Type" });
  });
});
