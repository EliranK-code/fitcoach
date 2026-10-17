"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  audit,
  authenticateAdmin,
  clearTotp,
  CoachLifecycleError,
  connectWhatsAppNumber,
  createAdminSession,
  createCoachFromPanel,
  createInviteLink,
  createResetLink,
  deleteAdminSession,
  deleteCoach,
  LinkError,
  openTenant,
  recordPlatformAction,
  resumeCoach,
  suspendCoach,
  updateCoach,
  verifyAdminCode,
  WhatsAppConfigError,
} from "@fitcoach/core";
import { adminToken, clearAdminCookie, publicOrigin, requireAdmin, setAdminCookie } from "../admin-session";
import { services } from "../services";
import { THROTTLED, throttled } from "../throttle";
import type { FormState } from "./auth";

// Admin panel actions. Each one checks the admin session itself (server actions are public endpoints)
// and records what it did in platform_audit.

export interface LinkState extends FormState {
  link?: string;
}

export async function adminLoginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "נא למלא אימייל וסיסמה" };
  if (await throttled("admin-login")) return { error: THROTTLED };
  const { handle } = await services();
  const result = await authenticateAdmin(handle.db, email, password);
  if (!result.ok) {
    return { error: result.reason === "locked" ? "החשבון ננעל זמנית. נסו שוב בעוד 15 דקות." : "אימייל או סיסמה שגויים" };
  }
  const { token, expiresAt } = await createAdminSession(handle.db, result.admin);
  await setAdminCookie(token, expiresAt);
  redirect("/admin/mfa");
}

export async function adminVerifyAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (await throttled("admin-code")) return { error: THROTTLED };
  const token = await adminToken();
  const { handle } = await services();
  const result = await verifyAdminCode(handle.db, token, String(form.get("code") ?? ""));
  if (!result.ok) {
    if (result.reason !== "invalid") await clearAdminCookie();
    const errors = { invalid: "הקוד לא נכון", locked: "החשבון ננעל זמנית. נסו שוב בעוד 15 דקות.", expired: "פג הזמן. התחברו מחדש." };
    return { error: errors[result.reason] };
  }
  await setAdminCookie(token!, result.expiresAt);
  const s = await requireAdmin();
  await recordPlatformAction(s.handle.db, { actor: s.actor, action: "admin_login" });
  redirect("/admin");
}

export async function adminLogoutAction(): Promise<void> {
  const token = await adminToken();
  if (token) await deleteAdminSession((await services()).handle.db, token);
  await clearAdminCookie();
  redirect("/admin/login");
}

export async function createCoachAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireAdmin();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  try {
    await createCoachFromPanel(s.handle.db, { slug, name: String(form.get("name") ?? ""), timezone: String(form.get("timezone") ?? "") || undefined }, s.actor);
  } catch (err) {
    if (err instanceof CoachLifecycleError) return { error: err.message };
    throw err;
  }
  redirect(`/admin/coaches/${slug}`);
}

export async function inviteAction(coachId: string, _prev: LinkState, form: FormData): Promise<LinkState> {
  const s = await requireAdmin();
  try {
    const token = await createInviteLink(s.handle.db, { coachId, email: String(form.get("email") ?? ""), createdBy: s.actor });
    return { ok: "הקישור נוצר. העתיקו ושלחו אותו למאמן: הוא יוצג רק עכשיו, ותקף ל-7 ימים.", link: `${await publicOrigin()}/invite/${token}` };
  } catch (err) {
    if (err instanceof LinkError) return { error: err.message };
    throw err;
  }
}

export async function resetLinkAction(userId: string, _prev: LinkState, _form: FormData): Promise<LinkState> {
  const s = await requireAdmin();
  const token = await createResetLink(s.handle.db, { userId, createdBy: s.actor });
  return { ok: "קישור לאיפוס הסיסמה, תקף ל-24 שעות. הוא יוצג רק עכשיו.", link: `${await publicOrigin()}/reset/${token}` };
}

export async function resetUserMfaAction(coachId: string, userId: string, email: string): Promise<void> {
  const s = await requireAdmin();
  await clearTotp(s.handle.db, userId);
  await recordPlatformAction(s.handle.db, { actor: s.actor, action: "user_mfa_reset", coachId, meta: { email } });
  const t = await openTenant(s.handle.db, coachId, { allowSuspended: true });
  await audit(s.handle.db, t, { actor: s.actor, action: "mfa_reset", targetType: "user", targetId: userId });
  revalidatePath("/admin/coaches/[slug]", "page");
}

export async function assignNumberAction(coachId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireAdmin();
  const phoneNumberId = String(form.get("phoneNumberId") ?? "").trim();
  if (!phoneNumberId) return { error: "חסר Phone number ID" };
  try {
    const t = await openTenant(s.handle.db, coachId, { allowSuspended: true });
    const account = await connectWhatsAppNumber(s.handle.db, t, { phoneNumberId, displayPhone: String(form.get("displayPhone") ?? "").trim() || undefined });
    await recordPlatformAction(s.handle.db, { actor: s.actor, action: "number_assigned", coachId, meta: { phoneNumberId: account.phoneNumberId } });
  } catch (err) {
    if (err instanceof WhatsAppConfigError) return { error: err.message };
    throw err;
  }
  revalidatePath("/admin/coaches/[slug]", "page");
  return { ok: "המספר חובר." };
}

/** The soft monthly budget: banners for the coach at 80% and 100%, never a hard stop. Empty removes it. */
export async function setBudgetAction(coachId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireAdmin();
  const raw = String(form.get("budget") ?? "").trim();
  const value = raw === "" ? undefined : Number(raw);
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) return { error: "תקציב בדולרים, מספר חיובי (או ריק כדי לבטל)" };
  const t = await openTenant(s.handle.db, coachId, { allowSuspended: true });
  await updateCoach(s.handle.db, t, { settings: { monthlyBudgetUsd: value } });
  await recordPlatformAction(s.handle.db, { actor: s.actor, action: "budget_set", coachId, meta: { monthlyBudgetUsd: value ?? null } });
  revalidatePath("/admin", "layout");
  return { ok: value === undefined ? "התקציב בוטל." : `התקציב עודכן: $${value} לחודש.` };
}

export async function suspendCoachAction(coachId: string): Promise<void> {
  const s = await requireAdmin();
  await suspendCoach(s.handle.db, coachId, s.actor);
  revalidatePath("/admin", "layout");
}

export async function resumeCoachAction(coachId: string): Promise<void> {
  const s = await requireAdmin();
  await resumeCoach(s.handle.db, coachId, s.actor, s.cfg);
  revalidatePath("/admin", "layout");
}

export async function deleteCoachAction(coachId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireAdmin();
  try {
    await deleteCoach(s.handle.db, coachId, { actor: s.actor, confirmSlug: String(form.get("confirm") ?? "").trim() });
  } catch (err) {
    if (err instanceof CoachLifecycleError) return { error: err.message };
    throw err;
  }
  redirect("/admin");
}
