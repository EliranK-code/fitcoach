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
      <Field label="אימייל">
        <Input value={email} readOnly dir="ltr" autoComplete="username" className="bg-slate-50 text-slate-600" />
      </Field>
      <Field label="סיסמה" hint="לפחות 10 תווים">
        <Input name="password" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
      </Field>
      <Field label="שוב, לאימות">
        <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} dir="ltr" />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "שומר…" : submitLabel}
      </Button>
    </form>
  );
}
