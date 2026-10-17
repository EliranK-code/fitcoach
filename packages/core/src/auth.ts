import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { decryptText, encryptText } from "./crypto";
import type { Db } from "./db/client";
import { coaches, coachUsers, sessions } from "./db/schema";
import { openTenant, type TenantContext } from "./tenancy";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

// Dashboard authentication: email + password, server-side sessions. Kept in our own database so the
// dashboard works the same on local PGlite and on Supabase, and every session is bound to one coach.

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

export class PasswordPolicyError extends Error {}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`הסיסמה צריכה להיות באורך ${MIN_PASSWORD_LENGTH} תווים לפחות`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

/** Generates a strong random password (shown once when a user is created or reset). */
export function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

export type CoachUser = typeof coachUsers.$inferSelect;

export async function createCoachUser(
  db: Db,
  input: { coachId: string; email: string; password: string; role?: "owner" | "staff" },
): Promise<CoachUser> {
  const [row] = await db
    .insert(coachUsers)
    .values({
      coachId: input.coachId,
      email: input.email.trim().toLowerCase(),
      passwordHash: await hashPassword(input.password),
      role: input.role ?? "owner",
    })
    .returning();
  if (!row) throw new Error("User insert failed");
  return row;
}

export async function findUserByEmail(db: Db, email: string): Promise<CoachUser | undefined> {
  const [row] = await db.select().from(coachUsers).where(eq(coachUsers.email, email.trim().toLowerCase()));
  return row;
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  await db
    .update(coachUsers)
    .set({ passwordHash: await hashPassword(password), failedAttempts: 0, lockedUntil: null })
    .where(eq(coachUsers.id, userId));
  // A password change ends every existing session.
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// Equalizes timing between "no such user" and "wrong password", so the login form can't probe for emails.
let dummyHash: Promise<string> | undefined;

export type LoginResult = { ok: true; user: CoachUser } | { ok: false; reason: "invalid" | "locked" | "suspended" };

export async function authenticate(db: Db, email: string, password: string, now = new Date()): Promise<LoginResult> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password-0000");
    await verifyPassword(password, await dummyHash);
    return { ok: false, reason: "invalid" };
  }
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: "locked" };

  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, reason: await registerFailure(db, user, now) };
  }
  // Checked only after the password, so the account's status isn't revealed to someone guessing.
  const [coach] = await db.select({ status: coaches.status }).from(coaches).where(eq(coaches.id, user.coachId));
  if (coach?.status !== "active") return { ok: false, reason: "suspended" };

  await db.update(coachUsers).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now }).where(eq(coachUsers.id, user.id));
  return { ok: true, user };
}

/** Counts a wrong password or code; the fifth in a row locks the account for LOCKOUT_MS. */
async function registerFailure(db: Db, user: CoachUser, now: Date): Promise<"invalid" | "locked"> {
  const failed = user.failedAttempts + 1;
  const locked = failed >= MAX_FAILED_ATTEMPTS;
  await db
    .update(coachUsers)
    .set({ failedAttempts: locked ? 0 : failed, lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS) : null })
    .where(eq(coachUsers.id, user.id));
  return locked ? "locked" : "invalid";
}

/** SHA-256 of a cookie or link token: the only form in which tokens are stored. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenId = hashToken;

/** True once the user confirmed a two-step code; then every login needs one. */
export const mfaEnabled = (user: CoachUser) => Boolean(user.totpEnabledAt && user.totpSecretEnc);

/**
 * Creates a session and returns the cookie token. Only its hash is stored. A user with two-step login gets
 * a pending session that grants nothing until verifyLoginCode accepts a code.
 */
export async function createSession(
  db: Db,
  user: CoachUser,
  now = new Date(),
  /** The browser already passed the code (e.g. replacing the session after a password change). */
  opts: { mfaVerified?: boolean } = {},
): Promise<{ token: string; expiresAt: Date; mfaPending: boolean }> {
  const token = randomBytes(32).toString("base64url");
  const mfaPending = mfaEnabled(user) && !opts.mfaVerified;
  // A pending session only has to live long enough to type the code.
  const expiresAt = new Date(now.getTime() + (mfaPending ? 10 * 60_000 : SESSION_TTL_MS));
  await db.insert(sessions).values({ id: tokenId(token), userId: user.id, coachId: user.coachId, mfaPending, expiresAt, lastSeenAt: now });
  // Opportunistic cleanup of this user's expired sessions.
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, now)));
  return { token, expiresAt, mfaPending };
}

export type CodeResult = { ok: true; expiresAt: Date } | { ok: false; reason: "invalid" | "locked" | "expired" };

/**
 * The second login step: checks the code for a pending session and, if it's right, turns it into a full
 * session. Wrong codes count toward the same lockout as wrong passwords.
 */
export async function verifyLoginCode(db: Db, token: string | undefined, code: string, now = new Date()): Promise<CodeResult> {
  if (!token) return { ok: false, reason: "expired" };
  const [row] = await db
    .select({ session: sessions, user: coachUsers })
    .from(sessions)
    .innerJoin(coachUsers, eq(coachUsers.id, sessions.userId))
    .where(and(eq(sessions.id, tokenId(token)), eq(sessions.mfaPending, true), gt(sessions.expiresAt, now)));
  if (!row || !mfaEnabled(row.user)) return { ok: false, reason: "expired" };
  const { user } = row;
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: "locked" };
  const t = await openTenant(db, user.coachId);
  const step = verifyTotp(decryptText(t, user.totpSecretEnc!), code, now, user.totpLastStep);
  if (step === null) {
    const reason = await registerFailure(db, user, now);
    if (reason === "locked") await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return { ok: false, reason };
  }
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ mfaPending: false, expiresAt, lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  await db.update(coachUsers).set({ totpLastStep: step, failedAttempts: 0, lockedUntil: null }).where(eq(coachUsers.id, user.id));
  return { ok: true, expiresAt };
}

/** Starts (or restarts) two-step setup: a new secret, stored encrypted but not active until confirmed. */
export async function beginTotpSetup(db: Db, t: TenantContext, user: CoachUser): Promise<{ secret: string; uri: string }> {
  if (mfaEnabled(user)) throw new MfaError("אימות דו-שלבי כבר פעיל");
  const secret = generateTotpSecret();
  await db.update(coachUsers).set({ totpSecretEnc: encryptText(t, secret), totpEnabledAt: null, totpLastStep: null }).where(eq(coachUsers.id, user.id));
  return { secret, uri: totpUri(secret, user.email) };
}

export class MfaError extends Error {}

async function freshUser(db: Db, userId: string): Promise<CoachUser> {
  const [row] = await db.select().from(coachUsers).where(eq(coachUsers.id, userId));
  if (!row) throw new MfaError("המשתמש לא נמצא");
  return row;
}

/** Activates two-step login once the user proves their app produces the right code. */
export async function confirmTotpSetup(db: Db, t: TenantContext, userId: string, code: string, now = new Date()): Promise<void> {
  const user = await freshUser(db, userId);
  if (!user.totpSecretEnc || user.totpEnabledAt) throw new MfaError("אין הגדרה פתוחה. התחילו מחדש");
  const step = verifyTotp(decryptText(t, user.totpSecretEnc), code, now);
  if (step === null) throw new MfaError("הקוד לא נכון. בדקו שהשעון בטלפון מדויק ונסו שוב");
  await db.update(coachUsers).set({ totpEnabledAt: now, totpLastStep: step }).where(eq(coachUsers.id, userId));
}

/** Turns two-step login off; needs a current code, so a stolen session alone can't do it. */
export async function disableTotp(db: Db, t: TenantContext, userId: string, code: string, now = new Date()): Promise<void> {
  const user = await freshUser(db, userId);
  if (!mfaEnabled(user)) return;
  if (verifyTotp(decryptText(t, user.totpSecretEnc!), code, now, user.totpLastStep) === null) throw new MfaError("הקוד לא נכון");
  await clearTotp(db, userId);
}

/** Removes two-step login without a code: for an admin, when the user lost their phone. */
export async function clearTotp(db: Db, userId: string): Promise<void> {
  await db.update(coachUsers).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null }).where(eq(coachUsers.id, userId));
}

export interface ValidSession {
  user: CoachUser;
  coachId: string;
  expiresAt: Date;
}

export async function validateSession(db: Db, token: string | undefined, now = new Date()): Promise<ValidSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: sessions, user: coachUsers })
    .from(sessions)
    .innerJoin(coachUsers, eq(coachUsers.id, sessions.userId))
    .innerJoin(coaches, eq(coaches.id, sessions.coachId))
    .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, now), eq(sessions.mfaPending, false), eq(coaches.status, "active")));
  if (!row) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  }
  return { user: row.user, coachId: row.session.coachId, expiresAt: row.session.expiresAt };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenId(token)));
}

/** Removes a dashboard user; their sessions go with them (FK cascade). */
export async function deleteCoachUser(db: Db, userId: string): Promise<void> {
  await db.delete(coachUsers).where(eq(coachUsers.id, userId));
}
