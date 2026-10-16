import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { EMBEDDING_DIMENSIONS } from "../db/schema.js";

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI embeddings. Returns null when OPENAI_API_KEY isn't configured: search then falls back to keywords. */
export function createEmbedder(): Embedder | null {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const model = cfg.OPENAI_EMBEDDING_MODEL;
  return {
    model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await client.embeddings.create({
          model,
          input: texts.slice(i, i + 64),
          dimensions: EMBEDDING_DIMENSIONS,
        });
        out.push(...res.data.map((d) => d.embedding));
      }
      return out;
    },
  };
}
