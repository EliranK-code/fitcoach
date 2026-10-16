"use server";

import { revalidatePath } from "next/cache";
import { audit, connectWhatsAppNumber, PLATFORM_FLOOR, updateCoach, WhatsAppConfigError } from "@fitcoach/core";
import { requireSession } from "../session";
import type { FormState } from "./auth";

export async function saveCoachSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "השם לא יכול להיות ריק" };
  const female = Number(form.get("calorieFloorFemale") || 0);
  const male = Number(form.get("calorieFloorMale") || 0);
  // Coaches may raise the floors, never lower them below the platform minimum.
  if (female && female < PLATFORM_FLOOR.female) return { error: `הרף לנשים לא יכול להיות נמוך מ-${PLATFORM_FLOOR.female}` };
  if (male && male < PLATFORM_FLOOR.male) return { error: `הרף לגברים לא יכול להיות נמוך מ-${PLATFORM_FLOOR.male}` };
  const timezone = String(form.get("timezone") ?? "").trim() || undefined;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      return { error: "אזור זמן לא תקין" };
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
  return { ok: "נשמר" };
}

export async function saveConsentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const reset = form.get("reset") === "1";
  const text = String(form.get("consentText") ?? "").trim();
  if (!reset && text.length < 100) return { error: "הנוסח קצר מדי: הודעת ההסכמה חייבת להסביר מה נאסף, למה, ומי מעבד את המידע" };
  // A new version id on every change, so each client's consent record points at the wording they saw.
  const version = reset ? undefined : `custom-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  await updateCoach(s.handle.db, s.t, { settings: { consentText: reset ? undefined : text, consentVersion: version } });
  await audit(s.handle.db, s.t, { actor: s.actor, action: reset ? "consent_text_reset" : "consent_text_updated", targetType: "coach", targetId: version ?? "default" });
  revalidatePath("/settings");
  return { ok: reset ? "חזרנו לנוסח ברירת המחדל" : `נשמר (גרסה ${version}). לקוחות חדשים יקבלו את הנוסח הזה.` };
}

export async function connectWhatsAppAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const phoneNumberId = String(form.get("phoneNumberId") ?? "").trim();
  if (!/^[\w-]{3,64}$/.test(phoneNumberId)) return { error: "Phone number ID לא תקין" };
  try {
    await connectWhatsAppNumber(s.handle.db, s.t, {
      phoneNumberId,
      displayPhone: String(form.get("displayPhone") ?? "").trim() || undefined,
    });
  } catch (err) {
    if (err instanceof WhatsAppConfigError) return { error: "המספר הזה כבר מחובר למאמן אחר" };
    throw err;
  }
  await audit(s.handle.db, s.t, { actor: s.actor, action: "whatsapp_connected", targetType: "whatsapp", targetId: phoneNumberId });
  revalidatePath("/settings");
  return { ok: "המספר חובר" };
}
