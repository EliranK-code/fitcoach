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
        <Field label="Quiet hours: from">
          <Input name="quietStart" defaultValue={values.quietStart} dir="ltr" placeholder="21:30" />
        </Field>
        <Field label="Until">
          <Input name="quietEnd" defaultValue={values.quietEnd} dir="ltr" placeholder="08:00" />
        </Field>
        <Field label="Check-in after days without a message" hint="0 = off">
          <Input name="inactivityDays" type="number" min={0} max={30} defaultValue={values.inactivityDays} dir="ltr" />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="skipShabbat" defaultChecked={values.skipShabbat} className="h-4 w-4 accent-emerald-600" />
          No reminders on Shabbat (Friday afternoon to Saturday night)
        </label>
      </div>

      <Notice tone="gray">
        Within 24 hours of the client's last message the free text is sent. Outside that window, WhatsApp allows only a template approved in WhatsApp Manager. Without a template
        set, the reminder isn't sent. <code>{"{name}"}</code> is replaced with the first name, and in a template the name is sent as <code dir="ltr">{"{{1}}"}</code>.
      </Notice>

      <div className="space-y-4">
        {KINDS.map((kind) => (
          <div key={kind} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 text-sm font-semibold">{REMINDER_KIND_LABEL[kind]}</div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-2">
                <Field label="Text (inside the 24-hour window)">
                  <Textarea name={`text_${kind}`} defaultValue={values.texts[kind]} rows={2} />
                </Field>
              </div>
              <div className="space-y-2">
                <Field label="Template name in Meta">
                  <Input name={`template_${kind}`} defaultValue={values.templates[kind]?.name ?? ""} dir="ltr" placeholder="weigh_in_reminder" />
                </Field>
                <Field label="Template language">
                  <Input name={`lang_${kind}`} defaultValue={values.templates[kind]?.language ?? "en"} dir="ltr" />
                </Field>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Button disabled={pending}>{pending ? "Saving…" : "Save reminder settings"}</Button>
    </form>
  );
}
