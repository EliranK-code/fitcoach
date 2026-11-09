"use client";

import { useActionState } from "react";
import { changePasswordAction, type FormState } from "@/lib/actions/auth";
import { saveClientAccessAction, saveCoachSettingsAction, saveConsentAction } from "@/lib/actions/settings";
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
        <Field label="Coach name">
          <Input name="name" defaultValue={props.name} required />
        </Field>
        <Field label="Time zone">
          <Select name="timezone" defaultValue={props.timezone}>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Minimum calorie floor for women (kcal)" hint={`Empty = ${props.minFemale}. You can only raise it.`}>
          <Input name="calorieFloorFemale" type="number" min={props.minFemale} step={50} defaultValue={props.floorFemale ?? ""} dir="ltr" />
        </Field>
        <Field label="Minimum calorie floor for men (kcal)" hint={`Empty = ${props.minMale}. You can only raise it.`}>
          <Input name="calorieFloorMale" type="number" min={props.minMale} step={50} defaultValue={props.floorMale ?? ""} dir="ltr" />
        </Field>
      </div>
      <Button disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
    </form>
  );
}

export function ClientAccessForm({ mode }: { mode: "approved_only" | "open" }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveClientAccessAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <Field
        label="Who can talk to the bot on WhatsApp"
        hint="In approved-only mode, a number you didn't add gets a short notice (at most once a day), and you get a join request. What it writes doesn't reach the AI and isn't stored."
      >
        <Select name="clientAccess" defaultValue={mode} className="max-w-sm">
          <option value="approved_only">Only clients I approved (recommended)</option>
          <option value="open">Anyone who writes to the number</option>
        </Select>
      </Field>
      <Button size="sm" variant="secondary" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

export function ConsentForm({ text, version, custom }: { text: string; version: string; custom: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveConsentAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <Notice tone="yellow">
        This text is a legal document. Every change should be checked by a lawyer, and the text must explain what is collected, why, who processes the data (including providers abroad), and how to ask to see or delete it.
      </Notice>
      <Textarea name="consentText" rows={12} defaultValue={text} />
      <p className="text-xs text-slate-500">
        Current version: <span dir="ltr">{version}</span>
        {custom ? " (custom text)" : " (default)"}. Each client is saved with the version they agreed to.
      </p>
      <div className="flex gap-2">
        <Button disabled={pending}>Save text</Button>
        {custom && (
          <Button name="reset" value="1" variant="secondary" disabled={pending}>
            Back to the default
          </Button>
        )}
      </div>
    </form>
  );
}


export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <Field label="Current password">
        <Input name="current" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="New password" hint="At least 10 characters">
          <Input name="next" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
        </Field>
        <Field label="Again, to confirm">
          <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
        </Field>
      </div>
      <Button size="sm" variant="secondary" disabled={pending}>
        Change password
      </Button>
    </form>
  );
}
