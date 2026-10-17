import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { hashPassword, hashToken, LOCKOUT_MS, MAX_FAILED_ATTEMPTS, verifyPassword, type CodeResult } from "./auth";
import { decryptText, encryptText, platformScope } from "./crypto";
import type { Db } from "./db/client";
import { platformAdmins, platformSessions } from "./db/schema";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

// Platform admins log into /admin with a password and, always, a TOTP code. They are created from the CLI
// only, never through the web. Their sessions are separate from coach sessions and shorter.

export const ADMIN_SESSION_TTL_MS = 12 * 3600_000;
/** Time to type the code (or finish TOTP setup) after the password. */
const ADMIN_PENDING_TTL_MS = 15 * 60_000;

export type PlatformAdmin = typeof platformAdmins.$inferSelect;

const normalize = (email: string) => email.trim().toLowerCase();

export async function createPlatformAdmin(db: Db, email: string, password: string): Promise<PlatformAdmin> {
  const [row] = await db.insert(platformAdmins).values({ email: normalize(email), passwordHash: await hashPassword(password) }).returning();
  if (!row) throw new Error("Admin insert failed");
  return row;
}

export async function findPlatformAdmin(db: Db, email: string): Promise<PlatformAdmin | undefined> {
  const [row] = await db.select().from(platformAdmins).where(eq(platformAdmins.email, normalize(email)));
  return row;
}

export async function listPlatformAdmins(db: Db): Promise<PlatformAdmin[]> {
  return db.select().from(platformAdmins).orderBy(asc(platformAdmins.email));
}

/** New password, TOTP cleared (set up again at next login), all sessions ended. For a locked-out admin, from the CLI. */
export async function resetPlatformAdmin(db: Db, adminId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db
    .update(platformAdmins)
    .set({ passwordHash, totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, failedAttempts: 0, lockedUntil: null })
    .where(eq(platformAdmins.id, adminId));
  await db.delete(platformSessions).where(eq(platformSessions.adminId, adminId));
}

export async function deletePlatformAdmin(db: Db, adminId: string): Promise<void> {
  await db.delete(platformAdmins).where(eq(platformAdmins.id, adminId));
}

async function registerFailure(db: Db, admin: PlatformAdmin, now: Date): Promise<"invalid" | "locked"> {
  const failed = admin.failedAttempts + 1;
  const locked = failed >= MAX_FAILED_ATTEMPTS;
  await db
    .update(platformAdmins)
    .set({ failedAttempts: locked ? 0 : failed, lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS) : null })
    .where(eq(platformAdmins.id, admin.id));
  return locked ? "locked" : "invalid";
}

let dummyHash: Promise<string> | undefined;

export type AdminLoginResult = { ok: true; admin: PlatformAdmin } | { ok: false; reason: "invalid" | "locked" };

/** The password step. Success only opens a pending session: the panel needs the TOTP step as well. */
export async function authenticateAdmin(db: Db, email: string, password: string, now = new Date()): Promise<AdminLoginResult> {
  const admin = await findPlatformAdmin(db, email);
  if (!admin) {
    dummyHash ??= hashPassword("not-a-real-password-0000");
    await verifyPassword(password, await dummyHash);
    return { ok: false, reason: "invalid" };
  }
  if (admin.lockedUntil && admin.lockedUntil > now) return { ok: false, reason: "locked" };
  if (!(await verifyPassword(password, admin.passwordHash))) return { ok: false, reason: await registerFailure(db, admin, now) };
  return { ok: true, admin };
}

export async function createAdminSession(db: Db, admin: PlatformAdmin, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ADMIN_PENDING_TTL_MS);
  await db.insert(platformSessions).values({ id: hashToken(token), adminId: admin.id, expiresAt, lastSeenAt: now });
  await db.delete(platformSessions).where(and(eq(platformSessions.adminId, admin.id), lt(platformSessions.expiresAt, now)));
  return { token, expiresAt };
}

export interface AdminSession {
  admin: PlatformAdmin;
  mfaVerified: boolean;
  expiresAt: Date;
}

/** Any live admin session, verified or still at the TOTP step. Pages check mfaVerified. */
export async function getAdminSession(db: Db, token: string | undefined, now = new Date()): Promise<AdminSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: platformSessions, admin: platformAdmins })
    .from(platformSessions)
    .innerJoin(platformAdmins, eq(platformAdmins.id, platformSessions.adminId))
    .where(and(eq(platformSessions.id, hashToken(token)), gt(platformSessions.expiresAt, now)));
  if (!row) return null;
  if (row.session.mfaVerified && now.getTime() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(platformSessions).set({ lastSeenAt: now }).where(eq(platformSessions.id, row.session.id));
  }
  return { admin: row.admin, mfaVerified: row.session.mfaVerified, expiresAt: row.session.expiresAt };
}

export async function deleteAdminSession(db: Db, token: string): Promise<void> {
  await db.delete(platformSessions).where(eq(platformSessions.id, hashToken(token)));
}

/**
 * For an admin without TOTP yet: returns the secret to show as a QR code, creating it on first call and
 * returning the same one on reloads until it's confirmed.
 */
export async function adminTotpSetup(db: Db, admin: PlatformAdmin): Promise<{ secret: string; uri: string }> {
  if (admin.totpEnabledAt) throw new Error("TOTP is already set up");
  let secret = admin.totpSecretEnc ? decryptText(platformScope(), admin.totpSecretEnc) : null;
  if (!secret) {
    secret = generateTotpSecret();
    await db.update(platformAdmins).set({ totpSecretEnc: encryptText(platformScope(), secret) }).where(eq(platformAdmins.id, admin.id));
  }
  return { secret, uri: totpUri(secret, admin.email, "FitCoach Admin") };
}

/**
 * The TOTP step: confirms first-time setup or checks the code at login, then makes the session a full
 * 12-hour one. Wrong codes count toward the lockout, and locking ends the pending session.
 */
export async function verifyAdminCode(db: Db, token: string | undefined, code: string, now = new Date()): Promise<CodeResult> {
  const session = await getAdminSession(db, token, now);
  if (!session || session.mfaVerified || !session.admin.totpSecretEnc) return { ok: false, reason: "expired" };
  const { admin } = session;
  if (admin.lockedUntil && admin.lockedUntil > now) return { ok: false, reason: "locked" };
  const step = verifyTotp(decryptText(platformScope(), admin.totpSecretEnc!), code, now, admin.totpLastStep);
  if (step === null) {
    const reason = await registerFailure(db, admin, now);
    if (reason === "locked") await deleteAdminSession(db, token!);
    return { ok: false, reason };
  }
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await db.update(platformSessions).set({ mfaVerified: true, expiresAt, lastSeenAt: now }).where(eq(platformSessions.id, hashToken(token!)));
  await db
    .update(platformAdmins)
    .set({ totpEnabledAt: admin.totpEnabledAt ?? now, totpLastStep: step, failedAttempts: 0, lockedUntil: null, lastLoginAt: now })
    .where(eq(platformAdmins.id, admin.id));
  return { ok: true, expiresAt };
}
