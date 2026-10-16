// Consent runs before any AI processing: until a client explicitly agrees, nothing they write is sent to
// Claude and only the minimum needed to reply (an encrypted phone number) is stored.
// DRAFT TEXT: must be reviewed by a lawyer before production (Israeli Privacy Protection Law, Amendment 13).

export const CONSENT_VERSION = "2026-10-v1";

export const CONSENT_BUTTONS = {
  accept: { id: "consent_yes", title: "מאשר/ת ✅" },
  decline: { id: "consent_no", title: "לא מאשר/ת" },
} as const;

export function consentText(coachName: string): string {
  return [
    `היי! 👋 כאן העוזר הדיגיטלי של ${coachName}. אני בוט מבוסס בינה מלאכותית (AI), שעובד לפי השיטה של ${coachName} ובפיקוח שלו/ה.`,
    "",
    "לפני שמתחילים, חשוב שתדע/י:",
    "• כדי ללוות אותך אאסוף ואשמור מידע אישי, כולל מידע בריאותי (גיל, משקל, פציעות, מחלות רקע, תזונה ואימונים).",
    `• המידע משמש רק לליווי שלך ונשמר מוצפן. גם ${coachName} יכול/ה לראות אותו.`,
    "• לצורך הפעלת השירות המידע מעובד גם אצל ספקים בחו\"ל: Anthropic (מודל ה-AI), OpenAI (חיפוש ותמלול) ו-Meta (וואטסאפ).",
    "• אני לא רופא/ה ולא מחליף/ה ייעוץ רפואי.",
    "• אינך חייב/ת למסור את המידע. בכל רגע אפשר לבקש לעיין במידע או למחוק אותו: פשוט כתבו \"מחק את המידע שלי\".",
    "",
    "מאשר/ת? השיבו *מאשר* כדי להתחיל, או *לא מאשר* אם לא.",
  ].join("\n");
}

export const CONSENT_DECLINED_TEXT =
  "בסדר גמור, לא נשמור ולא נעבד שום מידע. אם תשנו את דעתכם, פשוט כתבו *מאשר* 🙂";

const ACCEPT = new Set([
  "מאשר",
  "מאשרת",
  "מאשר/ת",
  "אני מאשר",
  "אני מאשרת",
  "מאשר ✅",
  "מאשר/ת ✅",
  "כן",
  "כן מאשר",
  "כן מאשרת",
  "1",
  "yes",
  "i agree",
  "agree",
  "i accept",
  "accept",
]);

const DECLINE = new Set(["לא מאשר", "לא מאשרת", "לא מאשר/ת", "לא", "2", "no", "i don't agree", "decline"]);

const normalize = (s: string) => s.trim().toLowerCase().replace(/[.!*"']/g, "").replace(/\s+/g, " ");

export function isConsentAccept(text: string, buttonId?: string): boolean {
  return buttonId === CONSENT_BUTTONS.accept.id || ACCEPT.has(normalize(text));
}

export function isConsentDecline(text: string, buttonId?: string): boolean {
  return buttonId === CONSENT_BUTTONS.decline.id || DECLINE.has(normalize(text));
}

// ----- Data deletion requests (right to erasure) -----

const DELETE_REQUEST = [
  /מחק(?:ו)? את (?:כל )?ה?מידע (?:שלי|עליי|עלי)/,
  /מחיקת (?:כל )?ה?מידע (?:שלי|עליי|עלי)/,
  /\b(?:delete|erase|remove) (?:all )?my (?:data|information|account)\b/i,
];
export const DELETE_CONFIRM_PHRASES = ["מחק לצמיתות", "delete permanently"];

export function isDeletionRequest(text: string): boolean {
  return DELETE_REQUEST.some((p) => p.test(text));
}

export function isDeletionConfirmation(text: string): boolean {
  return DELETE_CONFIRM_PHRASES.includes(normalize(text));
}

export const DELETE_CONFIRM_PROMPT =
  "כדי למחוק לצמיתות את כל המידע שלך (פרופיל, היסטוריה, תוכניות ושיחות), כתבו: *מחק לצמיתות*\nהמחיקה סופית ולא ניתן לשחזר אותה.";
export const DELETE_DONE_TEXT = "כל המידע שלך נמחק. תודה שהיית איתנו, ואם תרצו לחזור, פשוט כתבו לנו 💪";

export function looksHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}
