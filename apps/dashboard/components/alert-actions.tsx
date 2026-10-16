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
              ענה ללקוח
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setMode("resolve")}>
            סמן כטופל
          </Button>
        </div>
      )}
      {mode === "reply" && (
        <form action={reply} className="space-y-2">
          <input type="hidden" name="alertId" value={alertId} />
          <Textarea name="text" placeholder="התשובה שלך ללקוח…" required autoFocus />
          {hasQuestion && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" name="saveFaq" className="h-4 w-4 accent-emerald-600" />
              לשמור את השאלה והתשובה ב-FAQ, כדי שהבוט יענה בעצמו בפעם הבאה
            </label>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={replying}>
              {replying ? "שולח…" : "שלח וסגור"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode("none")}>
              ביטול
            </Button>
          </div>
        </form>
      )}
      {mode === "resolve" && (
        <form action={resolve} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="alertId" value={alertId} />
          <Input name="note" placeholder="הערה (לא חובה)" className="max-w-xs" />
          <Button size="sm" variant="secondary" disabled={resolving}>
            {resolving ? "סוגר…" : "סגור התראה"}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode("none")}>
            ביטול
          </Button>
        </form>
      )}
    </div>
  );
}
