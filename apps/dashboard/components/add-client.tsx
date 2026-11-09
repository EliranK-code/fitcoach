"use client";

import { useActionState } from "react";
import { addClientAction } from "@/lib/actions/clients";
import type { FormState } from "@/lib/actions/auth";
import { Button, Input, Notice } from "./ui";

/** Adds a client's WhatsApp number to the approved list. `countryCode`: local numbers are accepted with it (DEFAULT_COUNTRY_CODE). */
export function AddClientForm({ countryCode }: { countryCode?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addClientAction, {});
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input name="phone" type="tel" dir="ltr" required maxLength={40} placeholder="+14155550123" className="max-w-48" aria-label="Client's phone number" />
        <Button size="sm" disabled={pending}>
          Add client
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        {countryCode
          ? `International form with the country code (+14155550123), or a local number starting with 0, which gets +${countryCode}.`
          : "International form with the country code, for example +14155550123."}
      </p>
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
    </form>
  );
}
