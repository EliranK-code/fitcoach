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
    return { error: "The data isn't valid" };
  }
  const parsed = coachKnowledgeSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: `Some fields aren't valid: ${issues.join(" · ")}` };
  }
  const version = await publishKnowledge(s.handle.db, s.t, { data: parsed.data }, s.embedder);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "knowledge_published", targetType: "knowledge", targetId: String(version) });
  revalidatePath("/knowledge");
  return { ok: `Saved as version ${version}. Active conversations switch to the new knowledge on their next message.` };
}

export async function uploadDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file" };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 8MB" };
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED.includes(ext)) return { error: `Unsupported file type. Allowed: ${ALLOWED.join(", ")}` };

  let llm: LlmClient | null = null;
  try {
    llm = s.llm();
  } catch {
    // Without an API key, images can't be transcribed; text formats still work.
  }
  const doc = await extractDocument(file.name, Buffer.from(await file.arrayBuffer()), { llm, cfg: s.cfg, db: s.handle.db, tenant: s.t });
  if (!doc || !doc.text) {
    return { error: [".png", ".jpg", ".jpeg", ".webp"].includes(ext) && !llm ? "Images need ANTHROPIC_API_KEY" : "Couldn't extract text from the file" };
  }
  const version = await publishKnowledge(s.handle.db, s.t, { addDocuments: [doc] }, s.embedder);
  await audit(s.handle.db, s.t, { actor: s.actor, action: "document_added", targetType: "knowledge", targetId: file.name });
  revalidatePath("/knowledge");
  return { ok: `"${doc.title}" added (version ${version})` };
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
