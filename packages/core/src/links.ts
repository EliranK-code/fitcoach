import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { findUserByEmail, hashPassword, hashToken, type CoachUser } from "./auth";
import type { Db } from "./db/client";
import { coaches, coachUsers, sessions, userTokens } from "./db/schema";
import { recordPlatformAction } from "./platform";
import { audit } from "./repos/ops";
import { openTenant } from "./tenancy";

// One-time links an admin copies and sends by hand (there is no mail provider): an invitation that lets a
// new coach user pick a password, or a password reset. Only the SHA-256 of the token is stored, a link
// works once, and an expired, used or unknown link gets the same answer.

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 24 * 3600_000;

export class LinkError extends Error {}
const INVALID = "הקישור לא תקף: אולי כבר השתמשו בו או שפג תוקפו. בקשו קישור חדש.";

const newToken = () => randomBytes(32).toString("base64url");

export async function createInviteLink(db: Db, input: { coachId: string; email: string; createdBy: string; now?: Date }): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new LinkError("כתובת אימייל לא תקינה");
  if (await findUserByEmail(db, email)) throw new LinkError("כבר קיים משתמש עם האימייל הזה");
  const now = input.now ?? new Date();
  const token = newToken();
  await db.insert(userTokens).values({
    id: hashToken(token),
    purpose: "invite",
    coachId: input.coachId,
    email,
    createdBy: input.createdBy,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });
  await recordPlatformAction(db, { actor: input.createdBy, action: "invite_created", coachId: input.coachId, meta: { email } });
  return token;
}

export async function createResetLink(db: Db, input: { userId: string; createdBy: string; now?: Date }): Promise<string> {
  const [user] = await db.select().from(coachUsers).where(eq(coachUsers.id, input.userId));
  if (!user) throw new LinkError("המשתמש לא נמצא");
  const now = input.now ?? new Date();
  const token = newToken();
  await db.insert(userTokens).values({
    id: hashToken(token),
    purpose: "reset",
    coachId: user.coachId,
    email: user.email,
    userId: user.id,
    createdBy: input.createdBy,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
  });
  await recordPlatformAction(db, { actor: input.createdBy, action: "reset_link_created", coachId: user.coachId, meta: { email: user.email } });
  return token;
}

export interface LinkInfo {
  purpose: "invite" | "reset";
  email: string;
  coachName: string;
}

async function liveToken(db: Db, token: string, now: Date) {
  const [row] = await db
    .select({ token: userTokens, coachName: coaches.name })
    .from(userTokens)
    .innerJoin(coaches, eq(coaches.id, userTokens.coachId))
    .where(and(eq(userTokens.id, hashToken(token)), isNull(userTokens.usedAt), gt(userTokens.expiresAt, now), eq(coaches.status, "active")));
  return row ?? null;
}

/** What the link page shows before the password form; null for any link that can't be used. */
export async function inspectLink(db: Db, token: string, now = new Date()): Promise<LinkInfo | null> {
  const row = await liveToken(db, token, now);
  return row ? { purpose: row.token.purpose, email: row.token.email, coachName: row.coachName } : null;
}

/** Uses a link: an invitation creates the user, a reset sets the new password and ends every session. */
export async function redeemLink(db: Db, token: string, password: string, now = new Date()): Promise<{ user: CoachUser; purpose: "invite" | "reset" }> {
  const passwordHash = await hashPassword(password); // Policy errors surface before the link is spent.
  const row = await liveToken(db, token, now);
  if (!row) throw new LinkError(INVALID);
  const { token: link } = row;
  // Mark used first, conditionally, so two concurrent submissions can't both redeem it.
  const claimed = await db
    .update(userTokens)
    .set({ usedAt: now })
    .where(and(eq(userTokens.id, link.id), isNull(userTokens.usedAt)))
    .returning({ id: userTokens.id });
  if (claimed.length === 0) throw new LinkError(INVALID);

  let user: CoachUser;
  if (link.purpose === "invite") {
    if (await findUserByEmail(db, link.email)) throw new LinkError("כבר קיים משתמש עם האימייל הזה. אפשר להיכנס עם הסיסמה שלו.");
    const [created] = await db.insert(coachUsers).values({ coachId: link.coachId, email: link.email, passwordHash, role: "owner" }).returning();
    if (!created) throw new Error("User insert failed");
    user = created;
  } else {
    const [updated] = await db
      .update(coachUsers)
      .set({ passwordHash, failedAttempts: 0, lockedUntil: null })
      .where(eq(coachUsers.id, link.userId!))
      .returning();
    if (!updated) throw new LinkError(INVALID);
    await db.delete(sessions).where(eq(sessions.userId, updated.id));
    user = updated;
  }
  const t = await openTenant(db, link.coachId);
  await audit(db, t, {
    actor: `user:${user.email}`,
    action: link.purpose === "invite" ? "invite_accepted" : "password_reset_by_link",
    targetType: "user",
    targetId: user.id,
  });
  return { user, purpose: link.purpose };
}
