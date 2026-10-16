// Converts model output to WhatsApp formatting and splits it into messages a phone screen can handle.
// WhatsApp allows 4096 characters per text message; shorter chunks read better, so we split earlier.

export const MAX_MESSAGE_CHARS = 1500;

export function toWhatsAppFormat(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^#{1,6}\s*(.+?)\s*#*$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*+/g, "*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Splits on paragraph boundaries first, then lines, then words. */
export function splitForWhatsApp(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (!text) return [];
  if (text.length <= max) return [text];

  // Units are paragraphs; an oversized paragraph becomes its lines (hard-wrapped if a line is still too long).
  const units: { text: string; joiner: string }[] = [];
  for (const para of text.split(/\n\n/)) {
    if (para.length <= max) {
      units.push({ text: para, joiner: "\n\n" });
      continue;
    }
    const lines = para.split("\n").flatMap((l) => (l.length > max ? hardSplit(l, max) : [l]));
    lines.forEach((line, i) => units.push({ text: line, joiner: i === 0 ? "\n\n" : "\n" }));
  }

  const messages: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? current + unit.joiner + unit.text : unit.text;
    if (candidate.length > max && current) {
      messages.push(current.trim());
      current = unit.text;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

export function formatReply(text: string): string[] {
  return splitForWhatsApp(toWhatsAppFormat(text));
}
