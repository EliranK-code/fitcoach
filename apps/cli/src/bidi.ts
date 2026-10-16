import bidiFactory from "bidi-js";

// Windows Terminal and the VS Code terminal draw characters left-to-right in memory order, so Hebrew comes
// out reversed. We wrap each paragraph to the terminal width, reorder every line into visual order with the
// Unicode Bidirectional Algorithm, and right-align RTL paragraphs. Disable with --no-bidi on terminals that
// already handle RTL.

const bidi = bidiFactory();

const isHigh = (c: string) => c >= "\uD800" && c <= "\uDBFF";
const isLow = (c: string) => c >= "\uDC00" && c <= "\uDFFF";

/** Approximate terminal columns: emoji are double width, combining marks zero. */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    if (/\p{Mn}|‍|️/u.test(ch)) continue;
    width += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return width;
}

function wrap(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of paragraph.split(/(\s+)/)) {
    if (!word) continue;
    if (current && displayWidth(current + word) > width && word.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current || lines.length === 0) lines.push(current.trimEnd());
  return lines;
}

function visualLine(line: string): { text: string; rtl: boolean } {
  const levels = bidi.getEmbeddingLevels(line);
  const rtl = (levels.paragraphs[0]?.level ?? 0) % 2 === 1;
  const chars = line.split("");
  const mirrored = bidi.getMirroredCharactersMap(line, levels.levels);
  mirrored.forEach((ch, i) => {
    chars[i] = ch;
  });
  for (const segment of bidi.getReorderSegments(line, levels)) {
    const [start = 0, end = start] = segment;
    const slice = chars.slice(start, end + 1).reverse();
    chars.splice(start, slice.length, ...slice);
  }
  // Reversal splits UTF-16 surrogate pairs (emoji); put each pair back in order.
  for (let i = 0; i < chars.length - 1; i++) {
    if (isLow(chars[i]!) && isHigh(chars[i + 1]!)) {
      [chars[i], chars[i + 1]] = [chars[i + 1]!, chars[i]!];
      i++;
    }
  }
  return { text: chars.join(""), rtl };
}

export function renderForTerminal(text: string, opts: { bidi: boolean; width?: number; indent?: number }): string {
  if (!opts.bidi) return text;
  const width = Math.max(30, (opts.width ?? process.stdout.columns ?? 80) - 2 - (opts.indent ?? 0));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const lines = wrap(paragraph, width);
    const paragraphRtl = visualLine(paragraph).rtl;
    for (const line of lines) {
      const { text: visual } = visualLine(line);
      const pad = paragraphRtl ? Math.max(0, width - displayWidth(visual)) : 0;
      out.push(" ".repeat(pad) + visual);
    }
  }
  return out.join("\n");
}
