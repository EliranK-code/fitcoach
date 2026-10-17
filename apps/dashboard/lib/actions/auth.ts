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
  invalid: "הקוד לא נכון. נסו את הקוד הנוכחי מהאפליקציה.",
  locked: "החשבון ננעל זמנית אחרי כמה ניסיונות כושלים. נסו שוב בעוד 15 דקות.",
  expired: "פג הזמן להזנת הקוד. התחברו מחדש.",
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
  if (!email || !password) return { error: "נא למלא אימייל וסיסמה" };
  if (await throttled("login")) return { error: THROTTLED };

  const { handle } = await services();
  const result = await authenticate(handle.db, email, password);
  if (!result.ok) {
    const errors = {
      locked: "החשבון ננעל זמנית אחרי כמה ניסיונות כושלים. נסו שוב בעוד 15 דקות.",
      suspended: "החשבון מושהה, והבוט לא עונה ללקוחות כרגע. לפרטים פנו לתמיכה.",
      invalid: "אימייל או סיסמה שגויים",
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
  if (next !== String(form.get("confirm") ?? "")) return { error: "הסיסמאות החדשות לא תואמות" };
  if (!(await verifyPassword(current, s.user.passwordHash))) return { error: "הסיסמה הנוכחית שגויה" };
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
  return { ok: "הסיסמה עודכנה. שאר החיבורים נותקו." };
}

/** Invitation and reset links: set a password, then continue as a normal login (two-step code if enabled). */
export async function redeemLinkAction(token: string, _prev: FormState, form: FormData): Promise<FormState> {
  if (await throttled("link")) return { error: THROTTLED };
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "הסיסמאות לא תואמות" };
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
