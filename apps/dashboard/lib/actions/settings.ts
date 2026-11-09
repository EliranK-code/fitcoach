"use server";

import { revalidatePath } from "next/cache";
import {
  audit,
  completeEmbeddedSignup,
  EmbeddedSignupError,
  onboardingApiFor,
  PLATFORM_FLOOR,
  updateCoach,
  WhatsAppConfigError,
} from "@fitcoach/core";
import { requireSession } from "../session";
import { THROTTLED, throttled } from "../throttle";
import type { FormState } from "./auth";

export async function saveCoachSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "The name can't be empty" };
  const female = Number(form.get("calorieFloorFemale") || 0);
  const male = Number(form.get("calorieFloorMale") || 0);
  // Coaches may raise the floors, never lower them below the platform minimum.
  if (female && female < PLATFORM_FLOOR.female) return { error: `The floor for women can't be lower than ${PLATFORM_FLOOR.female}` };
  if (male && male < PLATFORM_FLOOR.male) return { error: `The floor for men can't be lower than ${PLATFORM_FLOOR.male}` };
  const timezone = String(form.get("timezone") ?? "").trim() || undefined;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      return { error: "Invalid time zone" };
    }
  }
  await updateCoach(s.handle.db, s.t, {
    name,
    settings: {
      calorieFloorFemale: female || undefined,
      calorieFloorMale: male || undefined,
      timezone,
    },
  });
  await audit(s.handle.db, s.t, { actor: s.actor, action: "settings_updated", targetType: "coach", targetId: s.t.coachId });
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

/** Who the bot answers on WhatsApp: only approved numbers, or anyone who writes. */
export async function saveClientAccessAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const mode = String(form.get("clientAccess") ?? "");
  if (mode !== "approved_only" && mode !== "open") return { error: "Invalid choice" };
  await updateCoach(s.handle.db, s.t, { settings: { clientAccess: mode } });
  await audit(s.handle.db, s.t, { actor: s.actor, action: "client_access_mode_set", targetType: "coach", targetId: s.t.coachId, meta: { mode } });
  revalidatePath("/", "layout");
  return { ok: mode === "open" ? "Saved: the bot will answer anyone who writes." : "Saved: the bot will answer only numbers you approved." };
}

export async function saveConsentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const reset = form.get("reset") === "1";
  const text = String(form.get("consentText") ?? "").trim();
  if (!reset && text.length < 100) return { error: "The text is too short: the consent notice must explain what is collected, why, and who processes the data" };
  // A new version id on every change, so each client's consent record points at the wording they saw.
  const version = reset ? undefined : `custom-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  await updateCoach(s.handle.db, s.t, { settings: { consentText: reset ? undefined : text, consentVersion: version } });
  await audit(s.handle.db, s.t, { actor: s.actor, action: reset ? "consent_text_reset" : "consent_text_updated", targetType: "coach", targetId: version ?? "default" });
  revalidatePath("/settings");
  return { ok: reset ? "Back to the default text" : `Saved (version ${version}). New clients will get this text.` };
}

/**
 * Embedded Signup's server side: the coach connects their own number. (Managed numbers under the
 * platform's Meta account are assigned only from the admin panel, so a coach can't claim one.)
 */
export async function completeSignupAction(input: { code: string; wabaId: string; phoneNumberId: string }): Promise<FormState> {
  const s = await requireSession();
  if (await throttled("embedded-signup")) return { error: THROTTLED };
  const api = onboardingApiFor(s.cfg);
  if (!api) return { error: "Connecting your own number isn't set up on this platform yet. Contact the administrator." };
  try {
    await completeEmbeddedSignup(s.handle.db, s.t, input, api, s.actor);
  } catch (err) {
    if (err instanceof EmbeddedSignupError || err instanceof WhatsAppConfigError) return { error: err.message };
    throw err;
  }
  revalidatePath("/settings");
  return { ok: "The number is connected. Messages to it are answered from now on by your knowledge base." };
}
