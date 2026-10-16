import { and, asc, cosineDistance, desc, eq, ilike, isNotNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { coaches, coachKnowledge, knowledgeChunks, knowledgeDocuments } from "../db/schema.js";
import type { TenantContext } from "../tenancy.js";
import { chunkText } from "./chunker.js";
import type { Embedder } from "./embeddings.js";
import { estimateTokens, renderCoachKnowledge } from "./render.js";
import { coachKnowledgeSchema, type CoachKnowledge } from "./schema.js";

export interface KnowledgeDocumentInput {
  title: string;
  filename: string;
  mime: string;
  text: string;
}

/**
 * Publishes a new knowledge version: optionally replaces the structured data and/or the document set,
 * then bumps the coach's knowledge_version. Active conversations notice the bump and roll over to a new
 * epoch with the updated knowledge on their next message.
 */
export async function publishKnowledge(
  db: Db,
  t: TenantContext,
  update: { data?: CoachKnowledge; documents?: KnowledgeDocumentInput[] },
  embedder: Embedder | null,
): Promise<number> {
  const current = await getKnowledge(db, t);
  const data = update.data ?? current?.data;
  if (!data) throw new Error("Coach has no knowledge yet: provide structured data first");

  // Embed outside the transaction: it's a network call.
  const prepared = update.documents?.map((doc) => ({ doc, chunks: chunkText(doc.text) }));
  let vectors: number[][] | null = null;
  if (prepared && embedder) {
    vectors = await embedder.embed(prepared.flatMap((p) => p.chunks));
  }

  return db.transaction(async (tx) => {
    const [coach] = await tx
      .select({ v: coaches.knowledgeVersion })
      .from(coaches)
      .where(eq(coaches.id, t.coachId));
    const version = (coach?.v ?? 0) + 1;
    await tx.insert(coachKnowledge).values({ coachId: t.coachId, version, data });

    if (prepared) {
      await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.coachId, t.coachId));
      let v = 0;
      for (const { doc, chunks } of prepared) {
        const [row] = await tx
          .insert(knowledgeDocuments)
          .values({
            coachId: t.coachId,
            title: doc.title,
            filename: doc.filename,
            mime: doc.mime,
            extractedText: doc.text,
            tokenEstimate: estimateTokens(doc.text),
          })
          .returning({ id: knowledgeDocuments.id });
        if (!row) throw new Error("Document insert failed");
        if (chunks.length) {
          await tx.insert(knowledgeChunks).values(
            chunks.map((content, chunkIndex) => ({
              coachId: t.coachId,
              documentId: row.id,
              chunkIndex,
              content,
              embedding: vectors ? (vectors[v++] ?? null) : null,
            })),
          );
        }
      }
    }

    await tx
      .update(coaches)
      .set({ knowledgeVersion: version, updatedAt: new Date() })
      .where(eq(coaches.id, t.coachId));
    t.knowledgeVersion = version;
    return version;
  });
}

export async function getKnowledge(db: Db, t: TenantContext): Promise<{ data: CoachKnowledge; version: number } | null> {
  const [row] = await db
    .select()
    .from(coachKnowledge)
    .where(eq(coachKnowledge.coachId, t.coachId))
    .orderBy(desc(coachKnowledge.version))
    .limit(1);
  if (!row) return null;
  return { data: coachKnowledgeSchema.parse(row.data), version: row.version };
}

export async function listDocuments(db: Db, t: TenantContext) {
  return db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      filename: knowledgeDocuments.filename,
      tokenEstimate: knowledgeDocuments.tokenEstimate,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.coachId, t.coachId))
    .orderBy(asc(knowledgeDocuments.title));
}

export interface KnowledgePrompt {
  text: string;
  version: number;
  /** true when documents were too large to inline and must be reached via search_coach_knowledge. */
  ragMode: boolean;
  documentTitles: string[];
}

export async function buildKnowledgePrompt(db: Db, t: TenantContext, inlineMaxTokens: number): Promise<KnowledgePrompt> {
  const knowledge = await getKnowledge(db, t);
  if (!knowledge) throw new Error("Coach has no knowledge base. Run the seed or import a coach first.");
  const docs = await db
    .select({ title: knowledgeDocuments.title, text: knowledgeDocuments.extractedText })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.coachId, t.coachId))
    .orderBy(asc(knowledgeDocuments.title));

  const structured = renderCoachKnowledge(knowledge.data, knowledge.version, []);
  const docTokens = docs.reduce((sum, d) => sum + estimateTokens(d.text), 0);
  const ragMode = estimateTokens(structured) + docTokens > inlineMaxTokens;
  return {
    text: ragMode ? structured : renderCoachKnowledge(knowledge.data, knowledge.version, docs),
    version: knowledge.version,
    ragMode,
    documentTitles: docs.map((d) => d.title),
  };
}

export interface SearchHit {
  content: string;
  documentTitle: string;
  score: number;
}

const HEBREW_PREFIXES = /^[והבלמשכ]/;

export function keywordTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    terms.add(raw);
    if (raw.length >= 4 && HEBREW_PREFIXES.test(raw)) terms.add(raw.slice(1));
  }
  return [...terms].slice(0, 12);
}

/** Searches only this coach's chunks: vector similarity when embeddings exist, keyword overlap otherwise. */
export async function searchKnowledge(
  db: Db,
  t: TenantContext,
  query: string,
  embedder: Embedder | null,
  limit = 5,
): Promise<SearchHit[]> {
  if (embedder) {
    const [hasVectors] = await db
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.coachId, t.coachId), isNotNull(knowledgeChunks.embedding)))
      .limit(1);
    if (hasVectors) {
      const [vec] = await embedder.embed([query]);
      if (vec) {
        const distance = cosineDistance(knowledgeChunks.embedding, vec);
        const rows = await db
          .select({ content: knowledgeChunks.content, title: knowledgeDocuments.title, distance })
          .from(knowledgeChunks)
          .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
          .where(and(eq(knowledgeChunks.coachId, t.coachId), isNotNull(knowledgeChunks.embedding)))
          .orderBy(distance)
          .limit(limit);
        return rows.map((r) => ({ content: r.content, documentTitle: r.title, score: 1 - Number(r.distance) }));
      }
    }
  }

  const terms = keywordTerms(query);
  if (terms.length === 0) return [];
  const rows = await db
    .select({ content: knowledgeChunks.content, title: knowledgeDocuments.title })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(and(eq(knowledgeChunks.coachId, t.coachId), or(...terms.map((term) => ilike(knowledgeChunks.content, `%${term}%`)))))
    .limit(50);
  return rows
    .map((r) => {
      const lower = r.content.toLowerCase();
      const score = terms.filter((term) => lower.includes(term)).length / terms.length;
      return { content: r.content, documentTitle: r.title, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

