import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptText } from "../src/crypto";
import { auditLog, whatsappAccounts } from "../src/db/schema";
import { listPlatformAudit } from "../src/platform";
import { createCoach, openTenant, type TenantContext } from "../src/tenancy";
import { connectWhatsAppNumber, disconnectWhatsAppNumber, WhatsAppConfigError } from "../src/whatsapp/accounts";
import {
  completeEmbeddedSignup,
  createMetaOnboardingApi,
  createMockOnboardingApi,
  EmbeddedSignupError,
  onboardingMode,
} from "../src/whatsapp/embedded-signup";
import { enqueueInbound } from "../src/whatsapp/inbox";
import { createTestApp, type TestApp } from "./helpers";

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** A stand-in for graph.facebook.com that records every call. */
function fakeGraph(overrides: { numbers?: { id: string; display_phone_number: string }[]; failRegister?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/oauth/access_token")) return json({ access_token: "business-token", token_type: "bearer" });
    if (url.includes("/phone_numbers")) return json({ data: overrides.numbers ?? [{ id: "111222", display_phone_number: "+972 50-111-2222", verified_name: "דנה כושר" }] });
    if (url.endsWith("/subscribed_apps")) return json({ success: true });
    if (url.endsWith("/register")) {
      return overrides.failRegister ? json({ error: { message: "Two step verification PIN mismatch", code: 133005 } }, 400) : json({ success: true });
    }
    return json({ error: { message: "unexpected", code: 1 } }, 404);
  }) as typeof fetch;
  const api = createMetaOnboardingApi({ appId: "app-1", appSecret: "secret-1", version: "v26.0", fetch: fetchImpl });
  return { api, calls };
}

describe("Embedded Signup", () => {
  let app: TestApp;
  let t: TenantContext;
  const input = { code: "one-time-code", wabaId: "waba-9", phoneNumberId: "111222" };

  beforeEach(async () => {
    app = await createTestApp();
    t = await app.tenant();
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  it("chooses live, simulated or no onboarding from the configuration", () => {
    const base = { WHATSAPP_DRY_RUN: false, META_APP_ID: "a", META_EMBEDDED_SIGNUP_CONFIG_ID: "c", WHATSAPP_APP_SECRET: "s" };
    expect(onboardingMode(base)).toBe("live");
    expect(onboardingMode({ ...base, META_EMBEDDED_SIGNUP_CONFIG_ID: undefined })).toBe("unavailable");
    expect(onboardingMode({ ...base, WHATSAPP_DRY_RUN: true, META_APP_ID: undefined })).toBe("mock");
  });

  it("exchanges the code, checks the number belongs to the WABA, subscribes, registers and connects it", async () => {
    const db = app.handle.db;
    const { api, calls } = fakeGraph();
    const account = await completeEmbeddedSignup(db, t, input, api, "user:coach@example.com");

    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      "GET https://graph.facebook.com/v26.0/oauth/access_token",
      "GET https://graph.facebook.com/v26.0/waba-9/phone_numbers",
      "POST https://graph.facebook.com/v26.0/waba-9/subscribed_apps",
      "POST https://graph.facebook.com/v26.0/111222/register",
    ]);
    const exchange = new URL(calls[0]!.url).searchParams;
    expect(Object.fromEntries(exchange)).toEqual({ client_id: "app-1", client_secret: "secret-1", code: "one-time-code" });
    expect(calls.slice(1).every((c) => c.auth === "Bearer business-token")).toBe(true);
    const pin = (calls[3]!.body as { pin: string }).pin;
    expect(calls[3]!.body).toEqual({ messaging_product: "whatsapp", pin });
    expect(pin).toMatch(/^\d{6}$/);

    expect(account).toMatchObject({ coachId: t.coachId, phoneNumberId: "111222", wabaId: "waba-9", mode: "embedded", displayPhone: "+972 50-111-2222", status: "active" });
    // Token and PIN are stored encrypted with the coach's key.
    expect(account.accessTokenEnc).not.toContain("business-token");
    expect(decryptText(t, account.accessTokenEnc!)).toBe("business-token");
    expect(decryptText(t, account.registrationPinEnc!)).toBe(pin);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "whatsapp_connected"))).length).toBe(1);
    expect((await listPlatformAudit(db)).map((r) => r.action)).toContain("number_connected_by_coach");

    // Running again (say, after a partial failure elsewhere) keeps the same PIN.
    const again = fakeGraph();
    await completeEmbeddedSignup(db, t, input, again.api, "user:coach@example.com");
    expect((again.calls[3]!.body as { pin: string }).pin).toBe(pin);
  });

  it("refuses a number the token's WABA doesn't own, and turns Meta errors into a retryable message", async () => {
    const db = app.handle.db;
    const foreign = fakeGraph({ numbers: [{ id: "999", display_phone_number: "+1 555" }] });
    await expect(completeEmbeddedSignup(db, t, input, foreign.api, "x")).rejects.toThrow(/לא שייך/);
    expect(foreign.calls.map((c) => c.url)).not.toContainEqual(expect.stringContaining("subscribed_apps"));

    const failing = fakeGraph({ failRegister: true });
    await expect(completeEmbeddedSignup(db, t, input, failing.api, "x")).rejects.toThrow(EmbeddedSignupError);
    await expect(completeEmbeddedSignup(db, t, input, failing.api, "x")).rejects.toThrow(/133005/);
    expect(await db.select().from(whatsappAccounts)).toEqual([]);
  });

  it("checks the number is free and the coach is ready before spending Meta's code", async () => {
    const db = app.handle.db;
    const other = await openTenant(db, await createCoach(db, { slug: "other", name: "אחרת" }));
    await connectWhatsAppNumber(db, other, { phoneNumberId: "111222" });
    const taken = fakeGraph();
    await expect(completeEmbeddedSignup(db, t, input, taken.api, "x")).rejects.toThrow(WhatsAppConfigError);
    expect(taken.calls).toEqual([]);

    const starter = await openTenant(db, await createCoach(db, { slug: "new", name: "חדשה", settings: { starterKnowledge: true } }));
    const early = fakeGraph();
    await expect(completeEmbeddedSignup(db, starter, { ...input, phoneNumberId: "333" }, early.api, "x")).rejects.toThrow(/בסיס הידע/);
    expect(early.calls).toEqual([]);
    await expect(completeEmbeddedSignup(db, t, { ...input, wabaId: "bad id!" }, fakeGraph().api, "x")).rejects.toThrow(EmbeddedSignupError);
  });

  it("works end to end in simulation, and a disconnected number is free and ignored", async () => {
    const db = app.handle.db;
    const account = await completeEmbeddedSignup(db, t, { code: "mock:sim-42:+972 50-000-0042", wabaId: "mock-waba", phoneNumberId: "sim-42" }, createMockOnboardingApi(), "x");
    expect(account).toMatchObject({ phoneNumberId: "sim-42", mode: "embedded", displayPhone: "+972 50-000-0042" });

    const other = await openTenant(db, await createCoach(db, { slug: "other", name: "אחרת" }));
    expect(await disconnectWhatsAppNumber(db, other.coachId, "sim-42")).toBeUndefined(); // not that coach's number
    expect(await disconnectWhatsAppNumber(db, t.coachId, "sim-42")).toMatchObject({ phoneNumberId: "sim-42" });
    const message = { phoneNumberId: "sim-42", from: "972500000001", id: "wamid.x", timestamp: new Date(), kind: "text" as const, text: "היי" };
    expect(await enqueueInbound(db, [message], { debounceMs: 0 })).toMatchObject({ unknownNumber: 1 });
    await connectWhatsAppNumber(db, other, { phoneNumberId: "sim-42" });
  });
});
