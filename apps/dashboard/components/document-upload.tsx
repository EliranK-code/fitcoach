"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { uploadDocumentAction } from "@/lib/actions/knowledge";
import { Button, Notice } from "./ui";

export function DocumentUpload() {
  const [state, action, pending] = useActionState<FormState, FormData>(uploadDocumentAction, {});
  const form = useRef<HTMLFormElement>(null);
  const inputId = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} onReset={() => setFileName(null)} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* The browser's own file button is labelled in the operating system's language, so this one stands
            in for it. The real input stays in the page, hidden, for keyboards and screen readers. */}
        <input
          id={inputId}
          type="file"
          name="file"
          accept=".md,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp"
          required
          onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
          className="peer sr-only"
        />
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600"
        >
          Choose file
        </label>
        <span className="max-w-48 truncate text-sm text-slate-500" title={fileName ?? undefined}>
          {fileName ?? "No file chosen"}
        </span>
        <Button size="sm" disabled={pending}>
          {pending ? "Processing…" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-slate-500">PDF, Word, text or an image (for example a photo of a meal plan, transcribed automatically). Up to 8MB.</p>
      {state.error && <Notice tone="red">{state.error}</Notice>}
      {state.ok && <Notice tone="green">{state.ok}</Notice>}
    </form>
  );
}
