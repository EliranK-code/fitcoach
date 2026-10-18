// Checks on the bot's outgoing text that don't depend on the model following instructions.

const CALORIE_NUMBER = [
  /\d[\d,.]*\s*(?:[-–]\s*\d[\d,.]*\s*)?(?:קק"ל|קק״ל|קלוריות|קלוריה|קל'|kcal|calories|cals?\b)/i,
  /(?:קלוריות|קק"ל|קק״ל|calories|kcal)[^\d\n]{0,15}\d{2,}/i,
];
const MACRO_NUMBER = [
  /\d+\s*(?:גרם|גר'|גר|g)\s*(?:של\s*)?(?:חלבון|פחמימות|פחמימה|שומן|protein|carbs?|fat)/i,
  /(?:חלבון|פחמימות|שומן|protein|carbs?|fat)[^\d\n]{0,10}\d+\s*(?:גרם|גר'|גר|g)\b/i,
];

/** True when the text states calorie or macro amounts. Used for clients flagged with eating-disorder risk. */
export function containsNutritionNumbers(text: string): boolean {
  return [...CALORIE_NUMBER, ...MACRO_NUMBER].some((p) => p.test(text));
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const runCache = new Map<string, Set<string>>();

/**
 * True when `text` repeats a run of `minWords` consecutive words from `source` (case and punctuation
 * ignored). Catches a reply that pastes the bot's instructions; a paraphrase or a few shared words don't count.
 */
export function quotesVerbatim(text: string, source: string, minWords = 8): boolean {
  const key = `${minWords}:${source}`;
  let runs = runCache.get(key);
  if (!runs) {
    const w = words(source);
    runs = new Set(w.slice(0, Math.max(0, w.length - minWords + 1)).map((_, i) => w.slice(i, i + minWords).join(" ")));
    if (runCache.size > 16) runCache.clear();
    runCache.set(key, runs);
  }
  const w = words(text);
  for (let i = 0; i + minWords <= w.length; i++) {
    if (runs.has(w.slice(i, i + minWords).join(" "))) return true;
  }
  return false;
}

export const LEAK_SAFE_REPLY_HE = "אני כאן בשביל האימונים, התזונה וההרגלים שלך 🙂 במה אפשר לעזור?";
export const LEAK_SAFE_REPLY_EN = "I'm here to help with your training, nutrition and habits 🙂 What can I help you with?";

export const ED_SAFE_FALLBACK_HE =
  "אני כאן בשבילך 💙 בוא/י נתמקד בהרגשה שלך ובהרגלים שעושים לך טוב, בלי מספרים. העברתי את השיחה גם למאמן/ת כדי שנוכל ללוות אותך כמו שצריך.";
export const ED_SAFE_FALLBACK_EN =
  "I'm here for you 💙 Let's focus on how you feel and on habits that support you, without numbers. I've also let your coach know so we can support you properly.";
