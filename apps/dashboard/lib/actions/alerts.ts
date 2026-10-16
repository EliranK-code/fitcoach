"use server";

import { revalidatePath } from "next/cache";
import { audit, getClient, getKnowledge, listAlerts, publishKnowledge, resolveAlert } from "@fitcoach/core";
import { sendAsCoach } from "../coach-message";
import { requireSession } from "../session";
import type { FormState } from "./auth";

async function findAlert(alertId: string) {
  const s = await requireSession();
  // listAlerts is scoped to this coach, so an id from another tenant is simply not found.
  const alert = (await listAlerts(s.handle.db, s.t)).find((a) => a.id === alertId);
  if (!alert) throw new Error("ההתראה לא נמצאה");
  return { s, alert };
}

export async function resolveAlertAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { s, alert } = await findAlert(String(form.get("alertId")));
  const note = String(form.get("note") ?? "").trim() || null;
  await resolveAlert(s.handle.db, s.t, alert.id, note);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "alert_resolved", targetType: "alert", targetId: alert.id });
  revalidatePath("/", "layout");
  return { ok: "סומן כטופל" };
}

/** Answers the client (WhatsApp or recorded), closes the alert, and optionally teaches the bot the answer. */
export async function replyToAlertAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { s, alert } = await findAlert(String(form.get("alertId")));
  const text = String(form.get("text") ?? "").trim();
  if (!text) return { error: "כתבו תשובה" };
  const client = await getClient(s.handle.db, s.t, alert.clientId);
  if (!client) return { error: "הלקוח לא נמצא (אולי נמחק)" };

  const sent = await sendAsCoach(s, client, text);
  if (!sent.ok) return { error: sent.error };
  await resolveAlert(s.handle.db, s.t, alert.id, text);

  let faqNote = "";
  if (form.get("saveFaq") === "on" && alert.question) {
    const knowledge = await getKnowledge(s.handle.db, s.t);
    if (knowledge) {
      const data = { ...knowledge.data, faq: [...knowledge.data.faq, { q: alert.question, a: text }] };
      await publishKnowledge(s.handle.db, s.t, { data }, s.embedder);
      await audit(s.handle.db, s.t, { actor: s.actor, action: "faq_added_from_alert", targetType: "alert", targetId: alert.id });
      faqNote = " והתשובה נשמרה ב-FAQ: מעכשיו הבוט יענה עליה בעצמו";
    }
  }
  revalidatePath("/", "layout");
  return { ok: `נשלח${faqNote}` };
}
