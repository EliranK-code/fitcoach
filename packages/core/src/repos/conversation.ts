import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { decryptJson, decryptOptional, encryptJson, encryptOptional } from "../crypto.js";
import type { Db } from "../db/client.js";
import { chatMessages, conversationEpochs, llmMessages } from "../db/schema.js";
import type { TenantContext } from "../tenancy.js";

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
    })
    .returning();
  if (!row) throw new Error("Epoch insert failed");
  return { row, system, messages: [] };
}

export async function closeEpoch(db: Db, t: TenantContext, epochId: string, reason: string): Promise<void> {
  await db
    .update(conversationEpochs)
    .set({ status: "closed", closedAt: new Date(), closeReason: reason })
    .where(and(eq(conversationEpochs.coachId, t.coachId), eq(conversationEpochs.id, epochId)));
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
  stats: { contextTokens: number },
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
      .set({ lastContextTokens: stats.contextTokens, lastActivityAt: new Date() })
      .where(and(eq(conversationEpochs.coachId, t.coachId), eq(conversationEpochs.id, epoch.row.id)));
  });
  epoch.messages.push(...newMessages);
  epoch.row = { ...epoch.row, lastContextTokens: stats.contextTokens, lastActivityAt: new Date() };
}

export type ChatSender = "client" | "bot" | "coach" | "system";

export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  sender: ChatSender;
  kind: string;
  body: string | null;
  createdAt: Date;
}

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
  },
): Promise<void> {
  await db.insert(chatMessages).values({
    coachId: t.coachId,
    clientId: input.clientId,
    direction: input.direction,
    sender: input.sender,
    kind: input.kind ?? "text",
    bodyEnc: encryptOptional(t, input.body),
    externalId: input.externalId,
  });
}

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
  return rows.reverse().map((r) => ({
    id: r.id,
    direction: r.direction as "in" | "out",
    sender: r.sender as ChatSender,
    kind: r.kind,
    body: decryptOptional(t, r.bodyEnc),
    createdAt: r.createdAt,
  }));
}
