import { estimateTokens } from "./render.js";

function splitLongParagraph(para: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  for (const sentence of para.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > maxChars) {
      flush();
      for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + sentence.length + 1 > maxChars) flush();
    buf = buf ? `${buf} ${sentence}` : sentence;
  }
  flush();
  return out;
}

/**
 * Splits text into overlapping chunks along paragraph boundaries. Paragraphs larger than the budget are
 * split on sentence boundaries, then hard-wrapped as a last resort.
 */
export function chunkText(text: string, maxTokens = 600, overlapTokens = 80): string[] {
  const maxChars = maxTokens * 3;
  const overlapChars = overlapTokens * 3;
  const pieces = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= maxChars ? [p] : splitLongParagraph(p, maxChars)));

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && estimateTokens(current) + estimateTokens(piece) > maxTokens) {
      chunks.push(current);
      current = `${current.slice(-overlapChars)}\n\n${piece}`;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
