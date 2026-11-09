"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addApprovedClient,
  approveClient,
  audit,
  ClientAccessError,
  deleteClientData,
  deliverTurn,
  getCoachAccount,
  logger,
  requireClient,
  revokeClientAccess,
  serviceWindowOpen,
  setClientFlags,
  updateClient,
} from "@fitcoach/core";
import { sendAsCoach } from "../coach-message";
import { requireSession } from "../session";
import type { FormState } from "./auth";

/** Every action re-reads the client through the session's tenant: ids from another coach aren't found. */
async function load(clientId: string) {
  const s = await requireSession();
  const client = await requireClient(s.handle.db, s.t, clientId);
  return { s, client };
}

/** The coach adds a client's WhatsApp number, so the bot answers it (approved-only mode). */
export async function addClientAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  try {
    const { created } = await addApprovedClient(s.handle.db, s.t, String(form.get("phone") ?? "").slice(0, 40), s.actor);
    revalidatePath("/", "layout");
    return { ok: created ? "Added. When the client writes to the number, the bot sends the consent notice and gets started." : "The number was already on the list, and now it's approved." };
  } catch (err) {
    if (err instanceof ClientAccessError) return { error: err.message };
    throw err;
  }
}

/**
 * Approves a join request (or restores access). A client who wrote in the last 24 hours and hasn't
 * consented yet gets the consent notice right away, so they don't have to write again.
 */
export async function approveClientAction(clientId: string): Promise<void> {
  const { s, client } = await load(clientId);
  const approved = await approveClient(s.handle.db, s.t, client, s.actor);
  const now = new Date();
  if (approved.channel === "whatsapp" && approved.consentStatus === "pending" && serviceWindowOpen(approved, now)) {
    const account = await getCoachAccount(s.handle.db, s.t);
    if (account) {
      try {
        const api = await s.whatsappApi(s.t, account.phoneNumberId);
        await deliverTurn(s.handle.db, s.t, approved, api, await s.engine.promptConsent(s.t.coachId, approved.id), now);
      } catch (err) {
        // The approval stands; the client gets the consent notice on their next message instead.
        logger.warn({ err, clientId: approved.id }, "consent notice after approval failed");
      }
    }
  }
  revalidatePath("/", "layout");
}

/** The bot stops answering this client (they get the "this number serves the coach's clients" notice). */
export async function revokeAccessAction(clientId: string): Promise<void> {
  const { s, client } = await load(clientId);
  await revokeClientAccess(s.handle.db, s.t, client.id, s.actor);
  revalidatePath("/", "layout");
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
  return { ok: "Sent" };
}

export async function deleteClientAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { s, client } = await load(String(form.get("clientId")));
  if (String(form.get("confirm") ?? "").trim() !== "delete") return { error: 'To delete, type "delete"' };
  await deleteClientData(s.handle.db, s.t, client.id, s.actor);
  revalidatePath("/", "layout");
  redirect("/clients");
}
