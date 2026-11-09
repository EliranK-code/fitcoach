"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  audit,
  authenticate,
  createSession,
  deleteSession,
  LinkError,
  openTenant,
  PasswordPolicyError,
  redeemLink,
  setPassword,
  verifyLoginCode,
  verifyPassword,
  type CoachUser,
} from "@fitcoach/core";
import { services } from "../services";
import { clearSessionCookie, requireSession, setSessionCookie, SESSION_COOKIE } from "../session";
import { THROTTLED, throttled } from "../throttle";

export interface FormState {
  error?: string;
  ok?: string;
}

const CODE_ERRORS = {
  invalid: "The code is wrong. Try the current code from the app.",
  locked: "The account is temporarily locked after several failed attempts. Try again in 15 minutes.",
  expired: "Time ran out for entering the code. Sign in again.",
};

/** Opens a session for a user who just proved their password; with two-step login, the code page comes next. */
async function startSession(user: CoachUser): Promise<never> {
  const { handle } = await services();
  const { token, expiresAt, mfaPending } = await createSession(handle.db, user);
  await setSessionCookie(token, expiresAt);
  if (mfaPending) redirect("/login/verify");
  const t = await openTenant(handle.db, user.coachId);
  await audit(handle.db, t, { actor: `user:${user.email}`, action: "login", targetType: "user", targetId: user.id });
  redirect("/");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter an email and a password" };
  if (await throttled("login")) return { error: THROTTLED };

  const { handle } = await services();
  const result = await authenticate(handle.db, email, password);
  if (!result.ok) {
    const errors = {
      locked: "The account is temporarily locked after several failed attempts. Try again in 15 minutes.",
      suspended: "The account is suspended, and the bot isn't answering clients right now. Contact support for details.",
      invalid: "Wrong email or password",
    };
    return { error: errors[result.reason] };
  }
  return startSession(result.user);
}

/** The second login step for users with two-step login. */
export async function verifyLoginCodeAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (await throttled("login-code")) return { error: THROTTLED };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const { handle } = await services();
  const result = await verifyLoginCode(handle.db, token, String(form.get("code") ?? ""));
  if (!result.ok) {
    if (result.reason !== "invalid") await clearSessionCookie();
    return { error: CODE_ERRORS[result.reason] };
  }
  await setSessionCookie(token!, result.expiresAt);
  const s = await requireSession();
  await audit(s.handle.db, s.t, { actor: s.actor, action: "login", targetType: "user", targetId: s.user.id });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const { handle } = await services();
    await deleteSession(handle.db, token);
  }
  await clearSessionCookie();
  redirect("/login");
}

export async function changePasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  if (next !== String(form.get("confirm") ?? "")) return { error: "The new passwords don't match" };
  if (!(await verifyPassword(current, s.user.passwordHash))) return { error: "The current password is wrong" };
  try {
    await setPassword(s.handle.db, s.user.id, next);
  } catch (err) {
    if (err instanceof PasswordPolicyError) return { error: err.message };
    throw err;
  }
  // Changing the password signed out every session; open a fresh one for this browser (already past the code).
  const { token, expiresAt } = await createSession(s.handle.db, { ...s.user }, new Date(), { mfaVerified: true });
  await setSessionCookie(token, expiresAt);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "password_changed", targetType: "user", targetId: s.user.id });
  return { ok: "The password was updated. Your other sessions were signed out." };
}

/** Invitation and reset links: set a password, then continue as a normal login (two-step code if enabled). */
export async function redeemLinkAction(token: string, _prev: FormState, form: FormData): Promise<FormState> {
  if (await throttled("link")) return { error: THROTTLED };
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "The passwords don't match" };
  const { handle } = await services();
  let user: CoachUser;
  try {
    ({ user } = await redeemLink(handle.db, token, password));
  } catch (err) {
    if (err instanceof PasswordPolicyError || err instanceof LinkError) return { error: err.message };
    throw err;
  }
  return startSession(user);
}
