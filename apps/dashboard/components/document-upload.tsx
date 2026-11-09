"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FormState } from "@/lib/actions/auth";
import { uploadDocumentAction } from "@/lib/actions/knowledge";
import { Button, Notice } from "./ui";

export function DocumentUpload() {
  const [state, action, pending] = useActionState<FormState, FormData>(uploadDocumentAction, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          name="file"
          accept=".md,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp"
          required
          className="text-sm file:me-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200"
        />
        <Button size="sm" disabled={pending}>
          {pending ? "Processing…" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-slate-500">PDF, Word, PDF, Word, text or an image (for example a photo of a meal plan, transcribed automatically). Up to 8MB. 8MB.</p>
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
    </form>
  );
}
