"use server";

import { revalidatePath } from "next/cache";
import { audit, beginTotpSetup, confirmTotpSetup, disableTotp, MfaError } from "@fitcoach/core";
import { qrDataUrl } from "../qr";
import { requireSession } from "../session";
import { THROTTLED, throttled } from "../throttle";
import type { FormState } from "./auth";

// Optional two-step login for coach users, from the settings page.

export async function startMfaSetupAction(): Promise<{ secret: string; qr: string } | { error: string }> {
  const s = await requireSession();
  try {
    const { secret, uri } = await beginTotpSetup(s.handle.db, s.t, s.user);
    return { secret, qr: await qrDataUrl(uri) };
  } catch (err) {
    if (err instanceof MfaError) return { error: err.message };
    throw err;
  }
}

export async function confirmMfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  if (await throttled("mfa")) return { error: THROTTLED };
  try {
    await confirmTotpSetup(s.handle.db, s.t, s.user.id, String(form.get("code") ?? ""));
  } catch (err) {
    if (err instanceof MfaError) return { error: err.message };
    throw err;
  }
  await audit(s.handle.db, s.t, { actor: s.actor, action: "mfa_enabled", targetType: "user", targetId: s.user.id });
  revalidatePath("/settings");
  return { ok: "Two-step verification is on. From now on every sign-in asks for a code from the app." };
}

export async function disableMfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  if (await throttled("mfa")) return { error: THROTTLED };
  try {
    await disableTotp(s.handle.db, s.t, s.user.id, String(form.get("code") ?? ""));
  } catch (err) {
    if (err instanceof MfaError) return { error: err.message };
    throw err;
  }
  await audit(s.handle.db, s.t, { actor: s.actor, action: "mfa_disabled", targetType: "user", targetId: s.user.id });
  revalidatePath("/settings");
  return { ok: "Two-step verification is off." };
}
