"use client";

import { useActionState, useState } from "react";
import { replyToAlertAction, resolveAlertAction } from "@/lib/actions/alerts";
import type { FormState } from "@/lib/actions/auth";
import { Button, Input, Notice, Textarea } from "./ui";

export function AlertActions({ alertId, hasQuestion, canReply }: { alertId: string; hasQuestion: boolean; canReply: boolean }) {
  const [mode, setMode] = useState<"none" | "reply" | "resolve">("none");
  const [replyState, reply, replying] = useActionState<FormState, FormData>(replyToAlertAction, {});
  const [resolveState, resolve, resolving] = useActionState<FormState, FormData>(resolveAlertAction, {});
  const state = mode === "reply" ? replyState : resolveState;

  return (
    <div className="mt-4 space-y-3">
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          {canReply && (
            <Button size="sm" onClick={() => setMode("reply")}>
              Reply to client
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setMode("resolve")}>
            Mark as handled
          </Button>
        </div>
      )}
      {mode === "reply" && (
        <form action={reply} className="space-y-2">
          <input type="hidden" name="alertId" value={alertId} />
          <Textarea name="text" placeholder="Your reply to the client…" required autoFocus />
          {hasQuestion && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" name="saveFaq" className="h-4 w-4 accent-emerald-600" />
              Save the question and answer to the FAQ, so the bot answers it by itself next time
            </label>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={replying}>
              {replying ? "Sending…" : "Send and close"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {mode === "resolve" && (
        <form action={resolve} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="alertId" value={alertId} />
          <Input name="note" placeholder="Note (optional)" className="max-w-xs" />
          <Button size="sm" variant="secondary" disabled={resolving}>
            {resolving ? "Closing…" : "Close alert"}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode("none")}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
