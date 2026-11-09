"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { Button, Field, Input, Notice } from "./ui";

/** Choosing a password from an invitation or reset link. */
export function LinkPasswordForm({ action, email, submitLabel }: { action: (prev: FormState, form: FormData) => Promise<FormState>; email: string; submitLabel: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-4">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      <Field label="Email">
        <Input value={email} readOnly dir="ltr" autoComplete="username" className="bg-slate-50 text-slate-600" />
      </Field>
      <Field label="Password" hint="At least 10 characters">
        <Input name="password" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
      </Field>
      <Field label="Again, to confirm">
        <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
