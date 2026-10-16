"use server";

import { deleteClientData, findClientByPhone, listChatMessages, MissingApiKeyError, type TurnEvent } from "@fitcoach/core";
import { requireSession, type AppSession } from "../session";

// The playground talks to the real engine as a test client (is_test), separate for each dashboard user.
// Test clients are hidden from the client list and the stats.

const playgroundId = (s: AppSession) => `playground:${s.user.id}`;

export interface PlaygroundEvent {
  kind: "tool" | "alert" | "epoch" | "guard" | "refusal" | "usage";
  text: string;
}

export interface PlaygroundReply {
  replies: string[];
  buttons?: { id: string; title: string }[];
  events: PlaygroundEvent[];
  error?: string;
}

function describe(e: TurnEvent): PlaygroundEvent {
  switch (e.type) {
    case "tool":
      return { kind: "tool", text: `${e.ok ? "✓" : "✗"} ${e.name} ${JSON.stringify(e.input).slice(0, 160)} → ${e.result.slice(0, 160)}` };
    case "alert":
      return { kind: "alert", text: `התראה למאמן: ${e.alertType} (${e.severity})${e.deduped ? " · כבר קיימת" : ""}` };
    case "epoch":
      return { kind: "epoch", text: `אפיזודת שיחה ${e.action === "created" ? "חדשה" : "חדשה אחרי סיכום"} (${e.reason})` };
    case "guard":
      return { kind: "guard", text: e.detail };
    case "refusal":
      return { kind: "refusal", text: `סירוב של מודל ה-AI (${e.category ?? "לא ידוע"})` };
    case "usage":
      return { kind: "usage", text: `${e.model}: קלט ${e.input}, מה-cache ${e.cacheRead}, נכתב ל-cache ${e.cacheWrite}, פלט ${e.output}` };
  }
}

export async function playgroundSend(text: string, buttonId?: string): Promise<PlaygroundReply> {
  const s = await requireSession();
  try {
    const res = await s.engine.handleInbound({
      coachId: s.t.coachId,
      phone: playgroundId(s),
      text,
      buttonId,
      channel: "playground",
      isTest: true,
    });
    return { replies: res.replies, buttons: res.buttons, events: res.events.map(describe), error: res.error };
  } catch (err) {
    if (err instanceof MissingApiKeyError) return { replies: [], events: [], error: err.message };
    throw err;
  }
}

export async function playgroundHistory(): Promise<{ sender: string; body: string | null }[]> {
  const s = await requireSession();
  const client = await findClientByPhone(s.handle.db, s.t, playgroundId(s));
  if (!client) return [];
  return (await listChatMessages(s.handle.db, s.t, client.id, 100)).map((m) => ({ sender: m.sender, body: m.body }));
}

/** Starts over: the test client and everything about it is deleted. */
export async function playgroundReset(): Promise<void> {
  const s = await requireSession();
  const client = await findClientByPhone(s.handle.db, s.t, playgroundId(s));
  if (client) await deleteClientData(s.handle.db, s.t, client.id, s.actor);
}
