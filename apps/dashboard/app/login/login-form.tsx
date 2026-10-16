"use client";

import { useActionState } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { loginAction, type FormState } from "@/lib/actions/auth";

export function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      <Field label="אימייל">
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label="סיסמה">
        <Input name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "מתחבר…" : "כניסה"}
      </Button>
    </form>
  );
}
