import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAdminSession, type PlatformAdmin } from "@fitcoach/core";
import { services, type Services } from "./services";

// Admin sessions use their own cookie, scoped to /admin, so a coach session and an admin session never
// stand in for each other.

export const ADMIN_COOKIE = "fc_admin";
const COOKIE_PATH = "/admin";

export interface AdminContext extends Services {
  admin: PlatformAdmin;
  mfaVerified: boolean;
  /** Audit actor label. */
  actor: string;
}

export const getAdmin = cache(async (): Promise<AdminContext | null> => {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  const svc = await services();
  const session = await getAdminSession(svc.handle.db, token);
  if (!session) return null;
  return { ...svc, admin: session.admin, mfaVerified: session.mfaVerified, actor: `admin:${session.admin.email}` };
});

/** For every panel page and admin action: a session that passed the TOTP step. */
export async function requireAdmin(): Promise<AdminContext> {
  const s = await getAdmin();
  if (!s) redirect("/admin/login");
  if (!s.mfaVerified) redirect("/admin/mfa");
  return s;
}

export async function adminToken(): Promise<string | undefined> {
  return (await cookies()).get(ADMIN_COOKIE)?.value;
}

export async function setAdminCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export async function clearAdminCookie(): Promise<void> {
  (await cookies()).set(ADMIN_COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
}

/** The dashboard's public origin, for the one-time links an admin copies. */
export async function publicOrigin(): Promise<string> {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
}
