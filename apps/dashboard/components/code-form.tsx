"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { Button, Field, Input, Notice } from "./ui";

/** A six-digit authenticator code, for any two-step action (login, setup confirmation, disabling). */
export function CodeForm({
  action,
  submitLabel,
  label = "The code from your authenticator app",
  variant = "primary",
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  label?: string;
  variant?: "primary" | "danger" | "secondary";
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-4">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
      <Field label={label}>
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          dir="ltr"
          className="text-center text-lg tracking-[0.4em]"
          placeholder="000000"
        />
      </Field>
      <Button type="submit" variant={variant} className="w-full" disabled={pending}>
        {pending ? "Checking…" : submitLabel}
      </Button>
    </form>
  );
}
