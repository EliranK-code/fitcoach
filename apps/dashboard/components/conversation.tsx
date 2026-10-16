"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import type { FormState } from "@/lib/actions/auth";
import { sendMessageAction } from "@/lib/actions/clients";
import { DELIVERY_LABEL } from "@/lib/labels";
import { Button, Notice, Textarea, WhatsAppText } from "./ui";

export interface ChatItem {
  id: string;
  direction: "in" | "out";
  sender: "client" | "bot" | "coach" | "system";
  kind: string;
  body: string | null;
  status: string | null;
  createdAt: string;
}

const SENDER: Record<ChatItem["sender"], { label: string; bubble: string }> = {
  client: { label: "לקוח/ה", bubble: "bg-white ring-1 ring-slate-200" },
  bot: { label: "בוט", bubble: "bg-emerald-50 ring-1 ring-emerald-100" },
  coach: { label: "את/ה (מאמן)", bubble: "bg-violet-50 ring-1 ring-violet-100" },
  system: { label: "מערכת", bubble: "bg-slate-100" },
};

export function Conversation(props: {
  clientId: string;
  initial: ChatItem[];
  timeZone: string;
  canSend: boolean;
  sendDisabledReason?: string;
}) {
  const [messages, setMessages] = useState(props.initial);
  const [state, action, pending] = useActionState<FormState, FormData>(sendMessageAction, {});
  const scroller = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/clients/${props.clientId}/messages`, { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as { messages: ChatItem[] };
      setMessages(json.messages);
    }
  }, [props.clientId]);

  // Poll while the page is open so new client messages and bot replies show up live.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (state.ok) {
      form.current?.reset();
      void refresh();
    }
  }, [state, refresh]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length]);

  const time = (d: string) => new Intl.DateTimeFormat("he-IL", { timeZone: props.timeZone, timeStyle: "short", dateStyle: "short" }).format(new Date(d));

  return (
    <div className="flex flex-col gap-3">
      <div ref={scroller} className="max-h-[32rem] space-y-3 overflow-y-auto rounded-lg bg-slate-50 p-3">
        {messages.length === 0 && <p className="py-8 text-center text-sm text-slate-500">עוד אין הודעות</p>}
        {messages.map((m) => {
          const style = SENDER[m.sender] ?? SENDER.system;
          const outgoing = m.direction === "out";
          return (
            <div key={m.id} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm shadow-sm ${style.bubble}`}>
                <div className="mb-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                  <span className="font-medium">{style.label}</span>
                  <span>{time(m.createdAt)}</span>
                  {outgoing && m.status && (
                    <span className={m.status === "failed" ? "text-red-600" : ""}>{DELIVERY_LABEL[m.status] ?? m.status}</span>
                  )}
                </div>
                <div className="whitespace-chat">
                  {m.body === null ? <span className="italic text-slate-400">(לא נשמר: נשלח לפני אישור הפרטיות)</span> : <WhatsAppText text={m.body} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {props.canSend ? (
        <form ref={form} action={action} className="space-y-2">
          <input type="hidden" name="clientId" value={props.clientId} />
          {state.error && <Notice tone="red">{state.error}</Notice>}
          <Textarea name="text" placeholder="כתבו ללקוח בשמכם…" required className="min-h-16" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">ההודעה נשלחת בשמך. הבוט יקבל אותה כרקע בהודעה הבאה של הלקוח.</span>
            <Button size="sm" disabled={pending}>
              {pending ? "שולח…" : "שלח"}
            </Button>
          </div>
        </form>
      ) : (
        <Notice tone="yellow">{props.sendDisabledReason}</Notice>
      )}
    </div>
  );
}
