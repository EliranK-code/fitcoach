"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { saveReminderSettingsAction } from "@/lib/actions/reminders";
import { REMINDER_KIND_LABEL } from "@/lib/labels";
import { Button, Field, Input, Notice, Textarea } from "./ui";

const KINDS = ["weigh_in", "workout", "checkin", "inactivity"] as const;

export interface ReminderFormValues {
  quietStart: string;
  quietEnd: string;
  skipShabbat: boolean;
  inactivityDays: number;
  texts: Record<(typeof KINDS)[number], string>;
  templates: Partial<Record<(typeof KINDS)[number], { name: string; language: string }>>;
}

export function ReminderSettingsForm({ values }: { values: ReminderFormValues }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveReminderSettingsAction, {});
  return (
    <form action={action} className="space-y-5">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
      <div className="grid gap-4 md:grid-cols-4">
        <Field label="שעות שקטות: מ-">
          <Input name="quietStart" defaultValue={values.quietStart} dir="ltr" placeholder="21:30" />
        </Field>
        <Field label="עד">
          <Input name="quietEnd" defaultValue={values.quietEnd} dir="ltr" placeholder="08:00" />
        </Field>
        <Field label="check-in אחרי ימים בלי הודעה" hint="0 = כבוי">
          <Input name="inactivityDays" type="number" min={0} max={30} defaultValue={values.inactivityDays} dir="ltr" />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="skipShabbat" defaultChecked={values.skipShabbat} className="h-4 w-4 accent-emerald-600" />
          בלי תזכורות בשבת
        </label>
      </div>

      <Notice tone="gray">
        בתוך 24 שעות מההודעה האחרונה של הלקוח נשלח הנוסח החופשי. מחוץ לחלון, וואטסאפ מתיר רק תבנית (template) שאושרה ב-WhatsApp Manager. בלי תבנית
        מוגדרת, התזכורת לא נשלחת. <code>{"{name}"}</code> מוחלף בשם הפרטי, ובתבנית השם נשלח כ-<code dir="ltr">{"{{1}}"}</code>.
      </Notice>

      <div className="space-y-4">
        {KINDS.map((kind) => (
          <div key={kind} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 text-sm font-semibold">{REMINDER_KIND_LABEL[kind]}</div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-2">
                <Field label="נוסח (בתוך חלון 24 השעות)">
                  <Textarea name={`text_${kind}`} defaultValue={values.texts[kind]} rows={2} />
                </Field>
              </div>
              <div className="space-y-2">
                <Field label="שם התבנית ב-Meta">
                  <Input name={`template_${kind}`} defaultValue={values.templates[kind]?.name ?? ""} dir="ltr" placeholder="weigh_in_reminder" />
                </Field>
                <Field label="שפת התבנית">
                  <Input name={`lang_${kind}`} defaultValue={values.templates[kind]?.language ?? "he"} dir="ltr" />
                </Field>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Button disabled={pending}>{pending ? "שומר…" : "שמירת הגדרות התזכורות"}</Button>
    </form>
  );
}
