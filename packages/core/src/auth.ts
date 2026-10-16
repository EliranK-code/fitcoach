import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "./db/client";
import { coaches, coachUsers, sessions } from "./db/schema";

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
    const failed = user.failedAttempts + 1;
    const locked = failed >= MAX_FAILED_ATTEMPTS;
    await db
      .update(coachUsers)
      .set({ failedAttempts: locked ? 0 : failed, lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS) : null })
      .where(eq(coachUsers.id, user.id));
    return { ok: false, reason: locked ? "locked" : "invalid" };
  }
  // Checked only after the password, so the account's status isn't revealed to someone guessing.
  const [coach] = await db.select({ status: coaches.status }).from(coaches).where(eq(coaches.id, user.coachId));
  if (coach?.status !== "active") return { ok: false, reason: "suspended" };

  await db.update(coachUsers).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now }).where(eq(coachUsers.id, user.id));
  return { ok: true, user };
}

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a session and returns the cookie token. Only its hash is stored. */
export async function createSession(db: Db, user: CoachUser, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: tokenId(token), userId: user.id, coachId: user.coachId, expiresAt, lastSeenAt: now });
  // Opportunistic cleanup of this user's expired sessions.
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, now)));
  return { token, expiresAt };
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
    .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, now), eq(coaches.status, "active")));
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
