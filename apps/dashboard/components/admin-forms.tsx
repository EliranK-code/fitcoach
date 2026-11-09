"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/lib/actions/auth";
import type { LinkState } from "@/lib/actions/admin";
import { adminLoginAction, createCoachAction } from "@/lib/actions/admin";
import { Button, Field, Input, Notice, Select } from "./ui";

function Feedback({ state }: { state: FormState }) {
  if (state.error) return <Notice tone="red">{state.error}</Notice>;
  if (state.ok) return <Notice tone="green">{state.ok}</Notice>;
  return null;
}

export function AdminLoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(adminLoginAction, {});
  return (
    <form action={action} className="space-y-4">
      <Feedback state={state} />
      <Field label="Email">
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Continue"}
      </Button>
    </form>
  );
}

const ZONES = ["Asia/Jerusalem", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

export function NewCoachForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createCoachAction, {});
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Coach name">
          <Input name="name" required />
        </Field>
        <Field label="slug" hint="Lowercase English letters, digits and hyphens. Used in the CLI">
          <Input name="slug" required dir="ltr" pattern="[a-z0-9][a-z0-9\-]{1,39}" placeholder="dana-fit" />
        </Field>
        <Field label="Time zone">
          <Select name="timezone" defaultValue="Asia/Jerusalem">
            {ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Button size="sm" disabled={pending}>
        Create coach
      </Button>
    </form>
  );
}

/** Shows a one-time link with a copy button. The link is never stored in clear, so this is the only chance to copy it. */
function OneTimeLink({ state }: { state: LinkState }) {
  const [copied, setCopied] = useState(false);
  if (!state.link) return <Feedback state={state} />;
  return (
    <div className="space-y-2">
      <Notice tone="green">{state.ok}</Notice>
      <div className="flex gap-2">
        <Input readOnly value={state.link} dir="ltr" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(state.link!);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function InviteForm({ action }: { action: (prev: LinkState, form: FormData) => Promise<LinkState> }) {
  const [state, formAction, pending] = useActionState<LinkState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <OneTimeLink state={state} />
      <Field label="New user's email">
        <Input name="email" type="email" required dir="ltr" />
      </Field>
      <Button size="sm" disabled={pending}>
        Create invite link
      </Button>
    </form>
  );
}

export function ResetLinkForm({ action }: { action: (prev: LinkState, form: FormData) => Promise<LinkState> }) {
  const [state, formAction, pending] = useActionState<LinkState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-2">
      <OneTimeLink state={state} />
      {!state.link && (
        <Button size="sm" variant="secondary" disabled={pending}>
          Password reset link
        </Button>
      )}
    </form>
  );
}

export function AssignNumberForm({ action }: { action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Phone number ID" hint="From Meta: WhatsApp → API Setup">
          <Input name="phoneNumberId" required dir="ltr" />
        </Field>
        <Field label="Display number (optional)">
          <Input name="displayPhone" dir="ltr" placeholder="+1 ..." />
        </Field>
      </div>
      <Button size="sm" disabled={pending}>
        Connect number
      </Button>
    </form>
  );
}

export function BudgetForm({
  action,
  budget,
  cap,
  defaultCap,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  budget: number | null;
  /** This coach's own cap, if set. */
  cap: number | null;
  /** COACH_MONTHLY_CAP_USD; 0 = no default cap. */
  defaultCap: number;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Monthly budget (USD)" hint="A soft limit: a banner for the coach at 80% and 100%, nothing stops. Empty = no budget">
          <Input name="budget" type="number" min="1" step="1" dir="ltr" defaultValue={budget ?? ""} className="max-w-32" />
        </Field>
        <Field
          label="Hard cap (USD))"
          hint={`When it's reached the bot stops answering until the end of the month. Empty = the default (${defaultCap > 0 ? `$${defaultCap}` : "no cap"})`}
        >
          <Input name="cap" type="number" min="1" step="1" dir="ltr" defaultValue={cap ?? ""} placeholder={defaultCap > 0 ? String(defaultCap) : ""} className="max-w-32" />
        </Field>
      </div>
      <Button size="sm" variant="secondary" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

export function DeleteCoachForm({ slug, action }: { slug: string; action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <p className="text-sm text-slate-600">
        Permanently deletes the coach, all their clients and all their data, including the encryption key. This can't be undone. Only a usage summary is kept in the platform log. To continue, type{" "}
        <code dir="ltr" className="rounded bg-slate-100 px-1">
          {slug}
        </code>
        :
      </p>
      <div className="flex gap-2">
        <Input name="confirm" required dir="ltr" autoComplete="off" className="max-w-56" />
        <Button variant="danger" size="sm" disabled={pending}>
          Delete permanently
        </Button>
      </div>
    </form>
  );
}
