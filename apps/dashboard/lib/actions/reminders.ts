"use server";

import { revalidatePath } from "next/cache";
import {
  audit,
  DEFAULT_REMINDER_TEXTS,
  disableClientReminders,
  isValidTime,
  requireClient,
  setClientFlags,
  updateCoach,
  type ReminderMessageKind,
  type ReminderSettings,
} from "@fitcoach/core";
import { requireSession } from "../session";
import type { FormState } from "./auth";

const KINDS: ReminderMessageKind[] = ["weigh_in", "workout", "checkin", "inactivity"];

export async function saveReminderSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const quietStart = String(form.get("quietStart") ?? "").trim();
  const quietEnd = String(form.get("quietEnd") ?? "").trim();
  if (!isValidTime(quietStart) || !isValidTime(quietEnd)) return { error: "שעות שקטות בפורמט HH:MM" };
  const inactivityDays = Number(form.get("inactivityDays") ?? 0);
  if (!Number.isInteger(inactivityDays) || inactivityDays < 0 || inactivityDays > 30) return { error: "ימים ללא פעילות: מספר שלם בין 0 ל-30" };

  const texts: ReminderSettings["texts"] = {};
  const templates: ReminderSettings["templates"] = {};
  for (const kind of KINDS) {
    const text = String(form.get(`text_${kind}`) ?? "").trim();
    // Only real changes are stored, so later improvements to the default wording still reach this coach.
    if (text && text !== DEFAULT_REMINDER_TEXTS[kind]) texts[kind] = text.slice(0, 1000);
    const name = String(form.get(`template_${kind}`) ?? "").trim();
    if (name) {
      if (!/^[a-z0-9_]{1,512}$/.test(name)) return { error: `שם תבנית לא תקין: ${name} (אותיות קטנות באנגלית, ספרות וקו תחתון)` };
      templates[kind] = { name, language: String(form.get(`lang_${kind}`) ?? "he").trim() || "he" };
    }
  }

  await updateCoach(s.handle.db, s.t, {
    settings: {
      reminders: { quietStart, quietEnd, skipShabbat: form.get("skipShabbat") === "on", inactivityDays, texts, templates },
    },
  });
  await audit(s.handle.db, s.t, { actor: s.actor, action: "reminder_settings_updated", targetType: "coach", targetId: s.t.coachId });
  revalidatePath("/settings");
  return { ok: "נשמר. תזכורות שכבר מתוזמנות יתעדכנו בהפעלה הבאה שלהן." };
}

/** The coach stops all proactive messages to one client (same effect as the client writing "STOP"). */
export async function stopClientRemindersAction(clientId: string): Promise<void> {
  const s = await requireSession();
  const client = await requireClient(s.handle.db, s.t, clientId);
  await setClientFlags(s.handle.db, s.t, client, { remindersOptOut: true });
  await disableClientReminders(s.handle.db, s.t, client.id);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "reminders_stopped", targetType: "client", targetId: client.id });
  revalidatePath(`/clients/${clientId}`);
}

