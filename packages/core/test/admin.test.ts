import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticate,
  beginTotpSetup,
  clearTotp,
  confirmTotpSetup,
  createCoachUser,
  createSession,
  disableTotp,
  findUserByEmail,
  hashToken,
  MfaError,
  validateSession,
  verifyLoginCode,
} from "../src/auth";
import { decryptText } from "../src/crypto";
import { openDatabase, type DbHandle } from "../src/db/client";
import { coachUsers, platformSessions, sessions, userTokens } from "../src/db/schema";
import { importCoachFromDir } from "../src/knowledge/importer";
import { getKnowledge, publishKnowledge } from "../src/knowledge/store";
import { createInviteLink, createResetLink, inspectLink, LinkError, redeemLink } from "../src/links";
import { CoachLifecycleError, createCoachFromPanel, listCoaches, listPlatformAudit, suspendCoach } from "../src/platform";
import {
  adminTotpSetup,
  authenticateAdmin,
  createAdminSession,
  createPlatformAdmin,
  findPlatformAdmin,
  getAdminSession,
  resetPlatformAdmin,
  verifyAdminCode,
} from "../src/platform-auth";
import { createCoach, openTenant, type TenantContext } from "../src/tenancy";
import { base32Decode, base32Encode, totpCode, totpStep, totpUri, verifyTotp } from "../src/totp";
import { connectWhatsAppNumber, WhatsAppConfigError } from "../src/whatsapp/accounts";
import { SEED_DIR, testConfig } from "./helpers";

const code = (secret: string, now: Date, offsetSteps = 0) => totpCode(secret, totpStep(now) + offsetSteps);

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    const key = Buffer.from("12345678901234567890");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, expected] of vectors) expect(totpCode(key, Math.floor(seconds / 30), 8)).toBe(expected);
  });

  it("round-trips base32 and builds an otpauth URI", () => {
    const buf = Buffer.from("hello, authenticator");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpUri("ABC", "a@b.co")).toBe("otpauth://totp/FitCoach%3Aa%40b.co?secret=ABC&issuer=FitCoach&algorithm=SHA1&digits=6&period=30");
  });

  it("accepts one step of drift either way, and never the same step twice", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = new Date("2026-10-17T10:00:00Z");
    const step = totpStep(now);
    expect(verifyTotp(secret, code(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, code(secret, now, -1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(secret, now, 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, code(secret, now, 2), now)).toBeNull();
    expect(verifyTotp(secret, code(secret, now), now, step)).toBeNull(); // replay
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });
});

describe("accounts, links and starter coaches", () => {
  let handle: DbHandle;
  let t: TenantContext;
  let now: Date;
  const cfg = testConfig();

  beforeEach(async () => {
    handle = await openDatabase({});
    const { coachId } = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
    t = await openTenant(handle.db, coachId);
    now = new Date("2026-10-17T10:00:00Z");
  });
  afterEach(async () => {
    await handle.close();
  });

  it("makes admins pass a mandatory TOTP step, set up on first login", async () => {
    const db = handle.db;
    await createPlatformAdmin(db, "Ops@Example.com", "admin-password-1");
    expect(await authenticateAdmin(db, "ops@example.com", "wrong-password-1", now)).toEqual({ ok: false, reason: "invalid" });
    const login = await authenticateAdmin(db, "ops@example.com", "admin-password-1", now);
    if (!login.ok) throw new Error("login failed");

    const { token } = await createAdminSession(db, login.admin, now);
    expect(await getAdminSession(db, token, now)).toMatchObject({ mfaVerified: false });
    const setup = await adminTotpSetup(db, login.admin);
    expect((await adminTotpSetup(db, (await findPlatformAdmin(db, "ops@example.com"))!)).secret).toBe(setup.secret); // stable across reloads
    expect(await verifyAdminCode(db, token, "000000", now)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyAdminCode(db, token, code(setup.secret, now), now)).toMatchObject({ ok: true });
    expect(await getAdminSession(db, token, now)).toMatchObject({ mfaVerified: true });
    expect((await findPlatformAdmin(db, "ops@example.com"))!.totpEnabledAt).not.toBeNull();

    // The same code can't open a second session.
    const second = await createAdminSession(db, (await findPlatformAdmin(db, "ops@example.com"))!, now);
    expect(await verifyAdminCode(db, second.token, code(setup.secret, now), now)).toEqual({ ok: false, reason: "invalid" });
    // Wrong codes lock the account and end the pending session.
    for (let i = 0; i < 3; i++) await verifyAdminCode(db, second.token, "000000", now);
    expect(await verifyAdminCode(db, second.token, "000000", now)).toEqual({ ok: false, reason: "locked" });
    expect(await getAdminSession(db, second.token, now)).toBeNull();
    expect(await authenticateAdmin(db, "ops@example.com", "admin-password-1", now)).toEqual({ ok: false, reason: "locked" });

    // The CLI reset: new password, TOTP set up again, every session gone.
    const admin = (await findPlatformAdmin(db, "ops@example.com"))!;
    await resetPlatformAdmin(db, admin.id, "new-admin-password");
    expect(await db.select().from(platformSessions)).toEqual([]);
    expect(await findPlatformAdmin(db, "ops@example.com")).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, lockedUntil: null });
  });

  it("gives coach users optional two-step login with a pending session until the code", async () => {
    const db = handle.db;
    const user = await createCoachUser(db, { coachId: t.coachId, email: "coach@example.com", password: "coach-password-1" });
    const plain = await createSession(db, user, now);
    expect(plain.mfaPending).toBe(false);
    expect(await validateSession(db, plain.token, now)).not.toBeNull();

    const { secret } = await beginTotpSetup(db, t, user);
    const stored = (await findUserByEmail(db, "coach@example.com"))!.totpSecretEnc!;
    expect(stored).not.toContain(secret);
    expect(decryptText(t, stored)).toBe(secret); // encrypted with the coach's own key
    await expect(confirmTotpSetup(db, t, user.id, "000000", now)).rejects.toThrow(MfaError);
    await confirmTotpSetup(db, t, user.id, code(secret, now), now);

    const later = new Date(now.getTime() + 60_000);
    const fresh = (await findUserByEmail(db, "coach@example.com"))!;
    const pending = await createSession(db, fresh, later);
    expect(pending.mfaPending).toBe(true);
    expect(await validateSession(db, pending.token, later)).toBeNull();
    expect(await verifyLoginCode(db, pending.token, "000000", later)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyLoginCode(db, pending.token, code(secret, later), later)).toMatchObject({ ok: true });
    expect((await validateSession(db, pending.token, later))?.user.email).toBe("coach@example.com");
    // A replayed code doesn't open another session; a session after a password change can skip the step.
    const again = await createSession(db, fresh, later);
    expect(await verifyLoginCode(db, again.token, code(secret, later), later)).toEqual({ ok: false, reason: "invalid" });
    expect((await createSession(db, fresh, later, { mfaVerified: true })).mfaPending).toBe(false);

    const evenLater = new Date(later.getTime() + 120_000);
    await expect(disableTotp(db, t, user.id, "000000", evenLater)).rejects.toThrow(MfaError);
    await disableTotp(db, t, user.id, code(secret, evenLater), evenLater);
    expect((await findUserByEmail(db, "coach@example.com"))!.totpEnabledAt).toBeNull();
    await beginTotpSetup(db, t, (await findUserByEmail(db, "coach@example.com"))!);
    await clearTotp(db, user.id);
    expect((await findUserByEmail(db, "coach@example.com"))!.totpSecretEnc).toBeNull();
  });

  it("hands out one-time invitation and reset links, storing only their hash", async () => {
    const db = handle.db;
    const token = await createInviteLink(db, { coachId: t.coachId, email: "New@Coach.com", createdBy: "admin:ops@example.com", now });
    const [row] = await db.select().from(userTokens);
    expect(row!.id).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await inspectLink(db, token, now)).toEqual({ purpose: "invite", email: "new@coach.com", coachName: t.coachName });
    await expect(createInviteLink(db, { coachId: t.coachId, email: "not-an-email", createdBy: "x", now })).rejects.toThrow(LinkError);

    await expect(redeemLink(db, token, "short", now)).rejects.toThrow(/10/); // policy first: the link isn't spent
    const { user, purpose } = await redeemLink(db, token, "new-coach-password", now);
    expect(purpose).toBe("invite");
    expect(user).toMatchObject({ coachId: t.coachId, email: "new@coach.com", role: "owner" });
    expect((await authenticate(db, "new@coach.com", "new-coach-password", now)).ok).toBe(true);
    await expect(redeemLink(db, token, "new-coach-password", now)).rejects.toThrow(LinkError);
    expect(await inspectLink(db, token, now)).toBeNull();
    await expect(createInviteLink(db, { coachId: t.coachId, email: "new@coach.com", createdBy: "x", now })).rejects.toThrow(/כבר קיים/);

    // Reset: works once, within 24 hours, and ends every session.
    const session = await createSession(db, user, now);
    const reset = await createResetLink(db, { userId: user.id, createdBy: "admin:ops@example.com", now });
    expect(await inspectLink(db, reset, new Date(now.getTime() + 25 * 3600_000))).toBeNull();
    await redeemLink(db, reset, "another-password-1", new Date(now.getTime() + 3600_000));
    expect(await validateSession(db, session.token, now)).toBeNull();
    expect((await authenticate(db, "new@coach.com", "another-password-1", now)).ok).toBe(true);

    // Links of a suspended coach don't work, and every link is in the platform log.
    const late = await createInviteLink(db, { coachId: t.coachId, email: "late@coach.com", createdBy: "x", now });
    await suspendCoach(db, t.coachId, "test", now);
    expect(await inspectLink(db, late, now)).toBeNull();
    const log = await listPlatformAudit(db);
    expect(log.filter((r) => r.action === "invite_created")).toHaveLength(2);
    expect(log.find((r) => r.action === "reset_link_created")).toMatchObject({ coachSlug: "demo", meta: { email: "new@coach.com" } });
  });

  it("creates panel coaches on starter knowledge and blocks a number until they publish their own", async () => {
    const db = handle.db;
    await expect(createCoachFromPanel(db, { slug: "Bad Slug", name: "x" }, "admin:a")).rejects.toThrow(CoachLifecycleError);
    await expect(createCoachFromPanel(db, { slug: "demo", name: "x" }, "admin:a")).rejects.toThrow(/כבר יש/);
    const coachId = await createCoachFromPanel(db, { slug: "dana-fit", name: "דנה", timezone: "Asia/Jerusalem" }, "admin:a");
    let dana = await openTenant(db, coachId);
    expect(dana.settings).toMatchObject({ starterKnowledge: true, timezone: "Asia/Jerusalem" });
    expect((await getKnowledge(db, dana))?.data.coach.name).toBe("דנה");
    expect((await listCoaches(db)).find((c) => c.slug === "dana-fit")).toMatchObject({ starterKnowledge: true, numbers: 0 });
    await expect(connectWhatsAppNumber(db, dana, { phoneNumberId: "pn-dana" })).rejects.toThrow(WhatsAppConfigError);

    // A document alone doesn't make the coach ready; publishing the structured knowledge does.
    await publishKnowledge(db, dana, { addDocuments: [{ title: "x", filename: "x.md", mime: "text/markdown", text: "x" }] }, null);
    expect((await openTenant(db, coachId)).settings.starterKnowledge).toBe(true);
    const data = (await getKnowledge(db, dana))!.data;
    await publishKnowledge(db, dana, { data: { ...data, philosophy: "שינוי קטן כל שבוע" } }, null);
    dana = await openTenant(db, coachId);
    expect(dana.settings.starterKnowledge).toBeUndefined();
    await connectWhatsAppNumber(db, dana, { phoneNumberId: "pn-dana" });
    expect((await listCoaches(db)).find((c) => c.slug === "dana-fit")).toMatchObject({ starterKnowledge: false, numbers: 1 });
    expect((await listPlatformAudit(db)).map((r) => r.action)).toContain("coach_created");
  });

  it("keeps sessions of users who aren't verified out of the dashboard queries", async () => {
    const db = handle.db;
    const other = await openTenant(db, await createCoach(db, { slug: "other", name: "אחר" }));
    const user = await createCoachUser(db, { coachId: other.coachId, email: "o@example.com", password: "other-password-1" });
    const { secret } = await beginTotpSetup(db, other, user);
    await confirmTotpSetup(db, other, user.id, code(secret, now), now);
    const pending = await createSession(db, (await findUserByEmail(db, "o@example.com"))!, now);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, hashToken(pending.token)));
    expect(row).toMatchObject({ mfaPending: true });
    expect(row!.expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(10 * 60_000);
    expect((await db.select().from(coachUsers).where(eq(coachUsers.id, user.id)))[0]!.totpSecretEnc).not.toBeNull();
  });
});
