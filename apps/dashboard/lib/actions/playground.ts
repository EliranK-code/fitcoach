"use server";

import {
  deleteClientData,
  findClientByPhone,
  hitRateLimit,
  listChatMessages,
  MissingApiKeyError,
  spendBlock,
  spendBlockMessage,
  spendCaps,
  type TurnEvent,
} from "@fitcoach/core";
import { requireSession, type AppSession } from "../session";

// The playground talks to the real engine as a test client (is_test), separate for each dashboard user.
// Test clients are hidden from the client list and the stats.

const playgroundId = (s: AppSession) => `playground:${s.user.id}`;

const PLAYGROUND_MAX_CHARS = 4096;
const PLAYGROUND_HOURLY_LIMIT = 60;
const PLAYGROUND_WINDOW_MS = 3600_000;

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
      return { kind: "alert", text: `Alert to the coach: ${e.alertType} (${e.severity})${e.deduped ? " · already open" : ""}` };
    case "epoch":
      return { kind: "epoch", text: `${e.action === "created" ? "New conversation episode" : "New episode after a summary"} (${e.reason})` };
    case "guard":
      return { kind: "guard", text: e.detail };
    case "refusal":
      return { kind: "refusal", text: `The AI model refused (${e.category ?? "unknown"})` };
    case "usage":
      return { kind: "usage", text: `${e.model}: input ${e.input}, cache read ${e.cacheRead}, cache write ${e.cacheWrite}, output ${e.output}` };
  }
}

export async function playgroundSend(text: string, buttonId?: string): Promise<PlaygroundReply> {
  const s = await requireSession();
  // Every message here is a real model call, so it has the same guards as WhatsApp: a length like WhatsApp's,
  // an hourly limit per coach, and the spending caps.
  if (typeof text !== "string" || text.length > PLAYGROUND_MAX_CHARS) return { replies: [], events: [], error: `Messages up to ${PLAYGROUND_MAX_CHARS} characters, like on WhatsApp` };
  if ((await hitRateLimit(s.handle.db, `playground:${s.t.coachId}`, PLAYGROUND_WINDOW_MS)) > PLAYGROUND_HOURLY_LIMIT) {
    return { replies: [], events: [], error: `You can send up to ${PLAYGROUND_HOURLY_LIMIT} messages an hour in the Playground. Try again in a few minutes.` };
  }
  const block = await spendBlock(s.handle.db, s.t, spendCaps(s.cfg));
  if (block) return { replies: [], events: [], error: spendBlockMessage(block) };
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
