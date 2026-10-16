"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit, deleteClientData, requireClient, setClientFlags, updateClient } from "@fitcoach/core";
import { sendAsCoach } from "../coach-message";
import { requireSession } from "../session";
import type { FormState } from "./auth";

/** Every action re-reads the client through the session's tenant: ids from another coach aren't found. */
async function load(clientId: string) {
  const s = await requireSession();
  const client = await requireClient(s.handle.db, s.t, clientId);
  return { s, client };
}

export async function setPausedAction(clientId: string, paused: boolean): Promise<void> {
  const { s, client } = await load(clientId);
  await updateClient(s.handle.db, s.t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
  await audit(s.handle.db, s.t, { actor: s.actor, action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
  revalidatePath(`/clients/${clientId}`);
}

export async function clearFlagsAction(clientId: string): Promise<void> {
  const { s, client } = await load(clientId);
  await setClientFlags(s.handle.db, s.t, client, { minor: undefined, eatingDisorderRisk: undefined });
  await audit(s.handle.db, s.t, { actor: s.actor, action: "flags_cleared", targetType: "client", targetId: client.id });
  revalidatePath(`/clients/${clientId}`);
}

export async function sendMessageAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { s, client } = await load(String(form.get("clientId")));
  const result = await sendAsCoach(s, client, String(form.get("text") ?? ""));
  if (!result.ok) return { error: result.error };
  revalidatePath(`/clients/${client.id}`);
  return { ok: "נשלח" };
}

export async function deleteClientAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { s, client } = await load(String(form.get("clientId")));
  if (String(form.get("confirm") ?? "").trim() !== "מחק") return { error: 'כדי למחוק, הקלידו "מחק"' };
  await deleteClientData(s.handle.db, s.t, client.id, s.actor);
  revalidatePath("/", "layout");
  redirect("/clients");
}
