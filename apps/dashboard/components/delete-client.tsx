"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { deleteClientAction } from "@/lib/actions/clients";
import { Button, Input, Notice } from "./ui";

export function DeleteClient({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(deleteClientAction, {});
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setOpen(true)}>
        מחיקת לקוח
      </Button>
    );
  }
  return (
    <form action={action} className="w-full space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
      <input type="hidden" name="clientId" value={clientId} />
      <p className="text-sm text-red-800">
        מחיקה סופית של הלקוח וכל המידע שלו: פרופיל, שיחות, יומנים, תוכניות והתראות. אי אפשר לשחזר. הקלידו <strong>מחק</strong> לאישור.
      </p>
      {state.error && <Notice tone="red">{state.error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Input name="confirm" className="max-w-32" autoFocus />
        <Button size="sm" variant="danger" disabled={pending}>
          {pending ? "מוחק…" : "מחק לצמיתות"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
