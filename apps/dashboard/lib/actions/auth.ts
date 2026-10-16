"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  audit,
  authenticate,
  createSession,
  deleteSession,
  openTenant,
  PasswordPolicyError,
  setPassword,
  verifyPassword,
} from "@fitcoach/core";
import { services } from "../services";
import { clearSessionCookie, requireSession, setSessionCookie, SESSION_COOKIE } from "../session";
import { cookies } from "next/headers";

// Per-IP throttle on top of the per-account lockout in the database (single-instance memory is enough here).
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;

function throttled(ip: string): boolean {
  const now = Date.now();
  const entry = attemptsByIp.get(ip);
  if (!entry || entry.resetAt < now) {
    attemptsByIp.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > IP_LIMIT;
}

export interface FormState {
  error?: string;
  ok?: string;
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "נא למלא אימייל וסיסמה" };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  if (throttled(ip)) return { error: "יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות." };

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
  const { token, expiresAt } = await createSession(handle.db, result.user);
  await setSessionCookie(token, expiresAt);
  const t = await openTenant(handle.db, result.user.coachId);
  await audit(handle.db, t, { actor: `user:${result.user.email}`, action: "login", targetType: "user", targetId: result.user.id });
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
  // Changing the password signed out every session; open a fresh one for this browser.
  const { token, expiresAt } = await createSession(s.handle.db, { ...s.user });
  await setSessionCookie(token, expiresAt);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "password_changed", targetType: "user", targetId: s.user.id });
  return { ok: "הסיסמה עודכנה. שאר החיבורים נותקו." };
}
