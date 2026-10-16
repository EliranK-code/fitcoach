"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { playgroundReset, playgroundSend, type PlaygroundEvent } from "@/lib/actions/playground";
import { Button, Notice, Textarea, WhatsAppText } from "./ui";

interface Line {
  from: "me" | "bot" | "event";
  text: string;
  kind?: PlaygroundEvent["kind"];
}

const EVENT_STYLE: Record<PlaygroundEvent["kind"], string> = {
  tool: "text-slate-500",
  alert: "text-amber-700",
  epoch: "text-sky-700",
  guard: "text-violet-700",
  refusal: "text-red-700",
  usage: "text-slate-400",
};

export function Playground({ history }: { history: { sender: string; body: string | null }[] }) {
  const [lines, setLines] = useState<Line[]>(() =>
    history.filter((h) => h.body).map((h) => ({ from: h.sender === "client" ? "me" : "bot", text: h.body! })),
  );
  const [buttons, setButtons] = useState<{ id: string; title: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState(true);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must return nothing.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length, pending]);

  const send = (body: string, buttonId?: string) => {
    if (!body.trim() && !buttonId) return;
    setLines((l) => [...l, { from: "me", text: body }]);
    setText("");
    setButtons([]);
    setError(null);
    start(async () => {
      const res = await playgroundSend(body, buttonId);
      setLines((l) => [
        ...l,
        ...res.events.map((e) => ({ from: "event" as const, text: e.text, kind: e.kind })),
        ...res.replies.map((r) => ({ from: "bot" as const, text: r })),
      ]);
      setButtons(res.buttons ?? []);
      if (res.error) setError(res.error);
    });
  };

  const reset = () =>
    start(async () => {
      await playgroundReset();
      setLines([]);
      setButtons([]);
      setError(null);
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
          להציג מה קורה מאחורי הקלעים (כלים, התראות, טוקנים)
        </label>
        <Button size="sm" variant="secondary" onClick={reset} disabled={pending}>
          התחל מחדש
        </Button>
      </div>

      <div className="h-[28rem] space-y-2 overflow-y-auto rounded-xl bg-[#efeae2] p-4">
        {lines.length === 0 && (
          <p className="py-16 text-center text-sm text-slate-500">כתבו הודעה כאילו אתם לקוח חדש. השיחה עוברת דרך אותו מנוע ואותם כללים כמו בוואטסאפ.</p>
        )}
        {lines.map((l, i) =>
          l.from === "event" ? (
            debug && (
              <div key={i} className={`text-center text-[11px] ${EVENT_STYLE[l.kind ?? "tool"]}`} dir="auto">
                {l.text}
              </div>
            )
          ) : (
            <div key={i} className={`flex ${l.from === "me" ? "justify-start" : "justify-end"}`}>
              <div className={`whitespace-chat max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${l.from === "me" ? "bg-[#d9fdd3]" : "bg-white"}`}>
                <WhatsAppText text={l.text} />
              </div>
            </div>
          ),
        )}
        {pending && <div className="text-end text-xs text-slate-500">הבוט מקליד…</div>}
        <div ref={end} />
      </div>

      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {buttons.map((b) => (
            <Button key={b.id} size="sm" variant="secondary" onClick={() => send(b.title, b.id)} disabled={pending}>
              {b.title}
            </Button>
          ))}
        </div>
      )}
      {error && <Notice tone="red">{error}</Notice>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder="הודעה…"
          className="min-h-11"
          rows={1}
        />
        <Button disabled={pending || !text.trim()}>שליחה</Button>
      </form>
    </div>
  );
}
