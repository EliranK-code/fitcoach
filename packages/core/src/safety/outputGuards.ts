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

export const ED_SAFE_FALLBACK_HE =
  "אני כאן בשבילך 💙 בוא/י נתמקד בהרגשה שלך ובהרגלים שעושים לך טוב, בלי מספרים. העברתי את השיחה גם למאמן/ת כדי שנוכל ללוות אותך כמו שצריך.";
export const ED_SAFE_FALLBACK_EN =
  "I'm here for you 💙 Let's focus on how you feel and on habits that support you, without numbers. I've also let your coach know so we can support you properly.";
