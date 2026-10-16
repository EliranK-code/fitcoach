import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { openTenant, validateSession, type CoachUser, type TenantContext } from "@fitcoach/core";
import { services, type Services } from "./services";

export const SESSION_COOKIE = "fc_session";

export interface AppSession extends Services {
  user: CoachUser;
  t: TenantContext;
  /** Audit actor label for this user. */
  actor: string;
}

/** The logged-in coach user and their tenant, or null. Cached per request. */
export const getSession = cache(async (): Promise<AppSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const svc = await services();
  const session = await validateSession(svc.handle.db, token);
  if (!session) return null;
  const t = await openTenant(svc.handle.db, session.coachId);
  return { ...svc, user: session.user, t, actor: `user:${session.user.email}` };
});

/** For pages, server actions and API routes: every one of them checks the session itself. */
export async function requireSession(): Promise<AppSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
