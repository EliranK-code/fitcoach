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
        Delete client
      </Button>
    );
  }
  return (
    <form action={action} className="w-full space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
      <input type="hidden" name="clientId" value={clientId} />
      <p className="text-sm text-red-800">
        Permanently deletes the client and all their data: profile, chats, logs, plans and alerts. This can't be undone. Type <strong>delete</strong> to confirm.
      </p>
      {state.error && <Notice tone="red">{state.error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Input name="confirm" className="max-w-32" autoFocus />
        <Button size="sm" variant="danger" disabled={pending}>
          {pending ? "Deleting…" : "Delete permanently"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
