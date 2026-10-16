"use server";

import { revalidatePath } from "next/cache";
import { audit, coachKnowledgeSchema, extractDocument, listDocuments, publishKnowledge, type LlmClient } from "@fitcoach/core";
import { requireSession } from "../session";
import type { FormState } from "./auth";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED = [".md", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"];

export async function saveKnowledgeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("data") ?? ""));
  } catch {
    return { error: "הנתונים לא תקינים" };
  }
  const parsed = coachKnowledgeSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: `יש שדות לא תקינים: ${issues.join(" · ")}` };
  }
  const version = await publishKnowledge(s.handle.db, s.t, { data: parsed.data }, s.embedder);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "knowledge_published", targetType: "knowledge", targetId: String(version) });
  revalidatePath("/knowledge");
  return { ok: `נשמר כגרסה ${version}. שיחות פעילות יעברו לידע החדש בהודעה הבאה שלהן.` };
}

export async function uploadDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "בחרו קובץ" };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "הקובץ גדול מ-8MB" };
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED.includes(ext)) return { error: `סוג קובץ לא נתמך. אפשר: ${ALLOWED.join(", ")}` };

  let llm: LlmClient | null = null;
  try {
    llm = s.llm();
  } catch {
    // Without an API key, images can't be transcribed; text formats still work.
  }
  const doc = await extractDocument(file.name, Buffer.from(await file.arrayBuffer()), { llm, cfg: s.cfg, db: s.handle.db, tenant: s.t });
  if (!doc || !doc.text) {
    return { error: [".png", ".jpg", ".jpeg", ".webp"].includes(ext) && !llm ? "תמונות דורשות ANTHROPIC_API_KEY" : "לא הצלחתי לחלץ טקסט מהקובץ" };
  }
  const version = await publishKnowledge(s.handle.db, s.t, { addDocuments: [doc] }, s.embedder);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "document_added", targetType: "knowledge", targetId: file.name });
  revalidatePath("/knowledge");
  return { ok: `"${doc.title}" נוסף (גרסה ${version})` };
}

export async function deleteDocumentAction(documentId: string): Promise<void> {
  const s = await requireSession();
  const docs = await listDocuments(s.handle.db, s.t);
  const doc = docs.find((d) => d.id === documentId);
  if (!doc) return;
  await publishKnowledge(s.handle.db, s.t, { removeDocumentIds: [doc.id] }, s.embedder);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "document_removed", targetType: "knowledge", targetId: doc.filename });
  revalidatePath("/knowledge");
}
