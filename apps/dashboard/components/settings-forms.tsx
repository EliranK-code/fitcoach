"use client";

import { useActionState } from "react";
import { changePasswordAction, type FormState } from "@/lib/actions/auth";
import { connectWhatsAppAction, saveCoachSettingsAction, saveConsentAction } from "@/lib/actions/settings";
import { Button, Field, Input, Notice, Select, Textarea } from "./ui";

function Feedback({ state }: { state: FormState }) {
  if (state.error) return <Notice tone="red">{state.error}</Notice>;
  if (state.ok) return <Notice tone="green">{state.ok}</Notice>;
  return null;
}

const ZONES = ["Asia/Jerusalem", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

export function CoachSettingsForm(props: { name: string; timezone: string; floorFemale?: number; floorMale?: number; minFemale: number; minMale: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveCoachSettingsAction, {});
  return (
    <form action={action} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="שם המאמן">
          <Input name="name" defaultValue={props.name} required />
        </Field>
        <Field label="אזור זמן">
          <Select name="timezone" defaultValue={props.timezone}>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
        <Field label='רף קלורי מינימלי לנשים (קק"ל)' hint={`ריק = ${props.minFemale}. אפשר רק להעלות.`}>
          <Input name="calorieFloorFemale" type="number" min={props.minFemale} step={50} defaultValue={props.floorFemale ?? ""} dir="ltr" />
        </Field>
        <Field label='רף קלורי מינימלי לגברים (קק"ל)' hint={`ריק = ${props.minMale}. אפשר רק להעלות.`}>
          <Input name="calorieFloorMale" type="number" min={props.minMale} step={50} defaultValue={props.floorMale ?? ""} dir="ltr" />
        </Field>
      </div>
      <Button disabled={pending}>{pending ? "שומר…" : "שמירה"}</Button>
    </form>
  );
}

export function ConsentForm({ text, version, custom }: { text: string; version: string; custom: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveConsentAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <Notice tone="yellow">
        הנוסח הזה הוא מסמך משפטי. כל שינוי צריך לעבור עורך דין, והנוסח חייב להסביר מה נאסף, למה, מי מעבד את המידע (כולל ספקים בחו"ל), ואיך מבקשים עיון או מחיקה.
      </Notice>
      <Textarea name="consentText" rows={12} defaultValue={text} />
      <p className="text-xs text-slate-500">
        גרסה נוכחית: <span dir="ltr">{version}</span>
        {custom ? " (נוסח מותאם)" : " (ברירת מחדל)"}. כל לקוח נשמר עם גרסת הנוסח שהוא אישר.
      </p>
      <div className="flex gap-2">
        <Button disabled={pending}>שמירת נוסח</Button>
        {custom && (
          <Button name="reset" value="1" variant="secondary" disabled={pending}>
            חזרה לברירת המחדל
          </Button>
        )}
      </div>
    </form>
  );
}

export function WhatsAppConnectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(connectWhatsAppAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Phone number ID" hint="מ-Meta: WhatsApp → API Setup">
          <Input name="phoneNumberId" required dir="ltr" />
        </Field>
        <Field label="המספר לתצוגה (לא חובה)">
          <Input name="displayPhone" dir="ltr" placeholder="+972 ..." />
        </Field>
      </div>
      <Button size="sm" disabled={pending}>
        חיבור מספר
      </Button>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <Field label="סיסמה נוכחית">
        <Input name="current" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="סיסמה חדשה" hint="לפחות 10 תווים">
          <Input name="next" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
        </Field>
        <Field label="שוב, לאימות">
          <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
        </Field>
      </div>
      <Button size="sm" variant="secondary" disabled={pending}>
        החלפת סיסמה
      </Button>
    </form>
  );
}
