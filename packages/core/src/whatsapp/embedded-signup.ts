import { randomInt } from "node:crypto";
import type { AppConfig } from "../config";
import { decryptOptional } from "../crypto";
import type { Db } from "../db/client";
import { recordPlatformAction } from "../platform";
import { audit } from "../repos/ops";
import type { TenantContext } from "../tenancy";
import { assertNumberAvailable, connectWhatsAppNumber, WhatsAppConfigError, type WhatsAppAccount } from "./accounts";
import { WhatsAppApiError } from "./api";

// Embedded Signup: a coach connects a WhatsApp number of their own from the dashboard. Meta's popup returns
// a one-time code plus the WABA and phone number the coach picked; the server exchanges the code for a
// business token, checks the number really belongs to that WABA (the ids come from the browser), subscribes
// the app to the WABA's webhooks and registers the number for Cloud API with a two-step PIN.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/

export class EmbeddedSignupError extends Error {}

export interface MetaOnboardingApi {
  readonly mode: "live" | "mock";
  /** Server-to-server: the popup's one-time code for a business token scoped to the coach's WABA. */
  exchangeCode(code: string): Promise<string>;
  wabaPhoneNumbers(wabaId: string, token: string): Promise<{ id: string; displayPhone: string | null; verifiedName: string | null }[]>;
  subscribeApp(wabaId: string, token: string): Promise<void>;
  registerNumber(phoneNumberId: string, pin: string, token: string): Promise<void>;
}

/**
 * Which onboarding the dashboard offers: live Meta when the app is configured, a simulation in dry run
 * (it connects a number whose messages only go to the log), otherwise none.
 */
export function onboardingMode(cfg: Pick<AppConfig, "WHATSAPP_DRY_RUN" | "META_APP_ID" | "META_EMBEDDED_SIGNUP_CONFIG_ID" | "WHATSAPP_APP_SECRET">) {
  if (cfg.WHATSAPP_DRY_RUN) return "mock" as const;
  return cfg.META_APP_ID && cfg.META_EMBEDDED_SIGNUP_CONFIG_ID && cfg.WHATSAPP_APP_SECRET ? ("live" as const) : ("unavailable" as const);
}

export function onboardingApiFor(cfg: AppConfig, fetchImpl: typeof fetch = fetch): MetaOnboardingApi | null {
  const mode = onboardingMode(cfg);
  if (mode === "mock") return createMockOnboardingApi();
  if (mode === "unavailable") return null;
  return createMetaOnboardingApi({ appId: cfg.META_APP_ID!, appSecret: cfg.WHATSAPP_APP_SECRET!, version: cfg.WHATSAPP_GRAPH_VERSION, fetch: fetchImpl });
}

export function createMetaOnboardingApi(opts: { appId: string; appSecret: string; version: string; fetch?: typeof fetch }): MetaOnboardingApi {
  const doFetch = opts.fetch ?? fetch;
  const base = `https://graph.facebook.com/${opts.version}`;

  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
    if (!res.ok || json.error) {
      throw new WhatsAppApiError(json.error?.message ?? `Graph API HTTP ${res.status}`, res.status, json.error?.code ?? null);
    }
    return json;
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  return {
    mode: "live",
    async exchangeCode(code) {
      const params = new URLSearchParams({ client_id: opts.appId, client_secret: opts.appSecret, code });
      const json = await call<{ access_token?: string }>(`${base}/oauth/access_token?${params}`);
      if (!json.access_token) throw new WhatsAppApiError("No access token in the code exchange", 502, null);
      return json.access_token;
    },
    async wabaPhoneNumbers(wabaId, token) {
      const json = await call<{ data?: { id: string; display_phone_number?: string; verified_name?: string }[] }>(
        `${base}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: bearer(token) },
      );
      return (json.data ?? []).map((n) => ({ id: n.id, displayPhone: n.display_phone_number ?? null, verifiedName: n.verified_name ?? null }));
    },
    async subscribeApp(wabaId, token) {
      await call(`${base}/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", headers: bearer(token) });
    },
    async registerNumber(phoneNumberId, pin, token) {
      await call(`${base}/${encodeURIComponent(phoneNumberId)}/register`, {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
    },
  };
}

/** Dry-run stand-in for Meta: accepts the simulated popup's ids and records nothing outside the database. */
export function createMockOnboardingApi(): MetaOnboardingApi {
  const issued = new Map<string, string>(); // token -> the WABA the simulated popup picked
  return {
    mode: "mock",
    async exchangeCode(code) {
      const token = `mock-token-${code}`;
      issued.set(token, code);
      return token;
    },
    async wabaPhoneNumbers(_wabaId, token) {
      // The simulated code carries the number it was issued for: "mock:<phoneNumberId>:<display>".
      const [, id, display] = (issued.get(token) ?? "").split(":");
      return id ? [{ id, displayPhone: display || null, verifiedName: "סימולציה" }] : [];
    },
    async subscribeApp() {},
    async registerNumber() {},
  };
}

const ID = /^[\w-]{3,64}$/;

/** The server side of Embedded Signup. Safe to run again after a partial failure: every Meta step is idempotent. */
export async function completeEmbeddedSignup(
  db: Db,
  t: TenantContext,
  input: { code: string; wabaId: string; phoneNumberId: string },
  api: MetaOnboardingApi,
  actor: string,
): Promise<WhatsAppAccount> {
  if (!input.code || !ID.test(input.wabaId) || !ID.test(input.phoneNumberId)) {
    throw new EmbeddedSignupError("הפרטים שחזרו מ-Meta לא שלמים. נסו שוב.");
  }
  // Before spending the one-time code: the coach may connect a number at all, and this one isn't someone else's.
  const existing = await assertNumberAvailable(db, t, input.phoneNumberId);
  try {
    const token = await api.exchangeCode(input.code);
    const number = (await api.wabaPhoneNumbers(input.wabaId, token)).find((n) => n.id === input.phoneNumberId);
    if (!number) throw new EmbeddedSignupError("המספר שנבחר לא שייך לחשבון העסקי שנבחר ב-Meta.");
    await api.subscribeApp(input.wabaId, token);
    // Keep the PIN of a number this coach already registered, so a repeat run doesn't change it.
    const pin = decryptOptional(t, existing?.registrationPinEnc) ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    await api.registerNumber(input.phoneNumberId, pin, token);
    const account = await connectWhatsAppNumber(db, t, {
      phoneNumberId: input.phoneNumberId,
      displayPhone: number.displayPhone ?? undefined,
      wabaId: input.wabaId,
      accessToken: token,
      mode: "embedded",
      registrationPin: pin,
    });
    await audit(db, t, { actor, action: "whatsapp_connected", targetType: "whatsapp", targetId: input.phoneNumberId, meta: { mode: "embedded", simulated: api.mode === "mock" } });
    await recordPlatformAction(db, { actor, action: "number_connected_by_coach", coachId: t.coachId, meta: { phoneNumberId: input.phoneNumberId, simulated: api.mode === "mock" } });
    return account;
  } catch (err) {
    if (err instanceof EmbeddedSignupError || err instanceof WhatsAppConfigError) throw err;
    if (err instanceof WhatsAppApiError) {
      throw new EmbeddedSignupError(`Meta החזירה שגיאה (${err.code ?? err.status}): ${err.message}. אפשר לנסות שוב.`);
    }
    throw err;
  }
}
