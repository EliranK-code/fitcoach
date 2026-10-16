import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { decryptJson, decryptOptional, encryptJson, encryptOptional } from "../crypto";
import type { Db } from "../db/client";
import { chatMessages, conversationEpochs, llmMessages } from "../db/schema";
import type { TenantContext } from "../tenancy";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type SystemBlock = Anthropic.Beta.BetaTextBlockParam;

export type EpochRow = typeof conversationEpochs.$inferSelect;

export interface Epoch {
  row: EpochRow;
  system: SystemBlock[];
  messages: MessageParam[];
}

export async function getActiveEpoch(db: Db, t: TenantContext, clientId: string): Promise<Epoch | null> {
  const [row] = await db
    .select()
    .from(conversationEpochs)
    .where(
      and(
        eq(conversationEpochs.coachId, t.coachId),
        eq(conversationEpochs.clientId, clientId),
        eq(conversationEpochs.status, "active"),
      ),
    );
  if (!row) return null;
  const msgs = await db
    .select()
    .from(llmMessages)
    .where(and(eq(llmMessages.coachId, t.coachId), eq(llmMessages.epochId, row.id)))
    .orderBy(asc(llmMessages.seq));
  return {
    row,
    system: decryptJson<SystemBlock[]>(t, row.systemEnc),
    messages: msgs.map((m) => decryptJson<MessageParam>(t, m.contentEnc)),
  };
}

export async function createEpoch(
  db: Db,
  t: TenantContext,
  clientId: string,
  system: SystemBlock[],
  platformHash: string,
): Promise<Epoch> {
  const [last] = await db
    .select({ seq: max(conversationEpochs.seq) })
    .from(conversationEpochs)
    .where(and(eq(conversationEpochs.coachId, t.coachId), eq(conversationEpochs.clientId, clientId)));
  const [row] = await db
    .insert(conversationEpochs)
    .values({
      coachId: t.coachId,
      clientId,
      seq: (last?.seq ?? 0) + 1,
      systemEnc: encryptJson(t, system),
      knowledgeVersion: t.knowledgeVersion,
      platformHash,
    })
    .returning();
  if (!row) throw new Error("Epoch insert failed");
  return { row, system, messages: [] };
}

/**
 * Closes an epoch and drops its raw history (messages, photos, the frozen profile snapshot): once it has
 * been summarized into long-term memory nothing replays it, and keeping health data we no longer need
 * isn't data minimization. The readable conversation stays in chat_messages.
 */
export async function closeEpoch(db: Db, t: TenantContext, epochId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(llmMessages).where(and(eq(llmMessages.coachId, t.coachId), eq(llmMessages.epochId, epochId)));
    await tx
      .update(conversationEpochs)
      .set({ status: "closed", closedAt: new Date(), closeReason: reason, systemEnc: encryptJson(t, []) })
      .where(and(eq(conversationEpochs.coachId, t.coachId), eq(conversationEpochs.id, epochId)));
  });
}

/**
 * Appends messages to the epoch. Messages are only ever appended: the stored prefix must stay
 * byte-identical so Claude's thinking blocks and the prompt cache remain valid.
 */
export async function appendEpochMessages(
  db: Db,
  t: TenantContext,
  epoch: Epoch,
  newMessages: MessageParam[],
  stats: { contextTokens: number; now: Date },
): Promise<void> {
  if (newMessages.length === 0) return;
  const startSeq = epoch.messages.length;
  await db.transaction(async (tx) => {
    await tx.insert(llmMessages).values(
      newMessages.map((m, i) => ({
        coachId: t.coachId,
        clientId: epoch.row.clientId,
        epochId: epoch.row.id,
        seq: startSeq + i,
        role: m.role,
        contentEnc: encryptJson(t, m),
      })),
    );
    await tx
      .update(conversationEpochs)
      .set({ lastContextTokens: stats.contextTokens, lastActivityAt: stats.now })
      .where(and(eq(conversationEpochs.coachId, t.coachId), eq(conversationEpochs.id, epoch.row.id)));
  });
  epoch.messages.push(...newMessages);
  epoch.row = { ...epoch.row, lastContextTokens: stats.contextTokens, lastActivityAt: stats.now };
}

export type ChatSender = "client" | "bot" | "coach" | "system";

export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  sender: ChatSender;
  kind: string;
  body: string | null;
  status: string | null;
  createdAt: Date;
}

/** Logs a message to the readable conversation and returns its id (used to attach delivery status later). */
export async function logChatMessage(
  db: Db,
  t: TenantContext,
  input: {
    clientId: string;
    direction: "in" | "out";
    sender: ChatSender;
    body: string | null;
    kind?: string;
    externalId?: string;
    status?: string;
    botSeen?: boolean;
  },
): Promise<string> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      coachId: t.coachId,
      clientId: input.clientId,
      direction: input.direction,
      sender: input.sender,
      kind: input.kind ?? "text",
      bodyEnc: encryptOptional(t, input.body),
      externalId: input.externalId,
      status: input.status,
      botSeen: input.botSeen ?? true,
    })
    .returning({ id: chatMessages.id });
  if (!row) throw new Error("Chat message insert failed");
  return row.id;
}

/** Records the provider's message id and status after an outbound message was handed to WhatsApp. */
export async function setChatDelivery(
  db: Db,
  t: TenantContext,
  messageId: string,
  delivery: { externalId: string | null; status: string },
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ externalId: delivery.externalId, status: delivery.status })
    .where(and(eq(chatMessages.coachId, t.coachId), eq(chatMessages.id, messageId)));
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Applies a WhatsApp status webhook. Statuses can arrive out of order, so a status only replaces a "lower"
 * one (sent < delivered < read; failed always wins). Not tenant-scoped: the provider id is globally unique.
 */
export async function applyDeliveryStatus(db: Db, externalId: string, status: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessages.id, status: chatMessages.status })
    .from(chatMessages)
    .where(eq(chatMessages.externalId, externalId));
  if (!row) return false;
  if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[row.status ?? ""] ?? 0)) return true;
  await db.update(chatMessages).set({ status }).where(eq(chatMessages.id, row.id));
  return true;
}

/** Messages the model hasn't seen yet (coach messages, messages during a pause), oldest first. */
export async function listUnseenChatMessages(db: Db, t: TenantContext, clientId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.coachId, t.coachId), eq(chatMessages.clientId, clientId), eq(chatMessages.botSeen, false)))
    .orderBy(asc(chatMessages.createdAt));
  return rows.map(toChatMessage(t));
}

export async function markChatMessagesSeen(db: Db, t: TenantContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(chatMessages)
    .set({ botSeen: true })
    .where(and(eq(chatMessages.coachId, t.coachId), inArray(chatMessages.id, ids)));
}

const toChatMessage = (t: TenantContext) => (r: typeof chatMessages.$inferSelect): ChatMessage => ({
  id: r.id,
  direction: r.direction as "in" | "out",
  sender: r.sender as ChatSender,
  kind: r.kind,
  body: decryptOptional(t, r.bodyEnc),
  status: r.status,
  createdAt: r.createdAt,
});

export async function listChatMessages(
  db: Db,
  t: TenantContext,
  clientId: string,
  limit = 200,
): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.coachId, t.coachId), eq(chatMessages.clientId, clientId)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows.reverse().map(toChatMessage(t));
}
