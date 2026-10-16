import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { textOf, type LlmClient } from "../llm/client";
import { recordUsage } from "../repos/ops";
import { CoachSuspendedError, createCoach, openTenant, openTenantBySlug, TenantNotFoundError, type TenantContext } from "../tenancy";
import type { Embedder } from "./embeddings";
import { coachKnowledgeSchema } from "./schema";
import { publishKnowledge, type KnowledgeDocumentInput } from "./store";

const TEXT_TYPES: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain" };
const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface ExtractDeps {
  llm: LlmClient | null;
  cfg: AppConfig;
  db: Db;
  tenant: TenantContext;
}

/** Turns a coach file into plain text: Markdown/text as is, PDF and Word extracted, images transcribed by Claude. */
export async function extractDocument(filename: string, data: Buffer, deps: ExtractDeps): Promise<KnowledgeDocumentInput | null> {
  const ext = extname(filename).toLowerCase();
  const title = basename(filename, ext).replace(/[-_]+/g, " ");

  if (TEXT_TYPES[ext]) return { title, filename, mime: TEXT_TYPES[ext], text: data.toString("utf8").trim() };

  if (ext === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return { title, filename, mime: "application/pdf", text: text.trim() };
  }

  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: data });
    return {
      title,
      filename,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: value.trim(),
    };
  }

  const imageType = IMAGE_TYPES[ext];
  if (imageType) {
    if (!deps.llm) return null;
    const res = await deps.llm.create({
      model: deps.cfg.CLAUDE_MODEL,
      max_tokens: 8000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: imageType, data: data.toString("base64") } },
            {
              type: "text",
              text: "This image is part of a fitness coach's materials (for example a menu or a training program). Transcribe it into clean Markdown in its original language, keeping every item, quantity, and note. Output only the transcription.",
            },
          ],
        },
      ],
    });
    await recordUsage(deps.db, deps.tenant, {
      kind: "ingest",
      model: res.model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    });
    const text = textOf(res.content);
    return text ? { title, filename, mime: imageType, text } : null;
  }

  return null;
}

export interface ImportResult {
  coachId: string;
  slug: string;
  version: number;
  created: boolean;
  documents: string[];
  skipped: string[];
}

/**
 * Imports a coach from a folder: coach.yaml (structured knowledge, validated) plus an optional docs/ folder.
 * Creates the coach on first import; later imports publish a new knowledge version.
 */
export async function importCoachFromDir(
  db: Db,
  dir: string,
  opts: { cfg: AppConfig; llm: LlmClient | null; embedder: Embedder | null; slug?: string },
): Promise<ImportResult> {
  const raw = parseYaml(await readFile(join(dir, "coach.yaml"), "utf8")) as Record<string, unknown>;
  const slug = opts.slug ?? (typeof raw.slug === "string" ? raw.slug : basename(dir));
  const data = coachKnowledgeSchema.parse(raw);

  let tenant: TenantContext;
  let created = false;
  try {
    tenant = await openTenantBySlug(db, slug);
  } catch (err) {
    if (!(err instanceof TenantNotFoundError) || err instanceof CoachSuspendedError) throw err;
    tenant = await openTenant(db, await createCoach(db, { slug, name: data.coach.name }));
    created = true;
  }

  const documents: KnowledgeDocumentInput[] = [];
  const skipped: string[] = [];
  const docsDir = join(dir, "docs");
  const files = await readdir(docsDir).catch(() => [] as string[]);
  for (const file of files.sort()) {
    const doc = await extractDocument(file, await readFile(join(docsDir, file)), {
      llm: opts.llm,
      cfg: opts.cfg,
      db,
      tenant,
    });
    if (doc && doc.text) documents.push(doc);
    else skipped.push(file);
  }

  const version = await publishKnowledge(db, tenant, { data, documents }, opts.embedder);
  return { coachId: tenant.coachId, slug, version, created, documents: documents.map((d) => d.filename), skipped };
}
