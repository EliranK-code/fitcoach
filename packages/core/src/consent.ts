// Consent runs before any AI processing: until a client explicitly agrees, nothing they write is sent to
// Claude and only the minimum needed to reply (an encrypted phone number) is stored.
// DRAFT TEXT: must be reviewed by a lawyer before production, against the privacy law where you operate.
// The bot's fixed texts are English; replies from the AI follow the client's language. Hebrew answers to the
// consent and deletion prompts are still understood.

export const CONSENT_VERSION = "2026-11-en-v1";

export const CONSENT_BUTTONS = {
  accept: { id: "consent_yes", title: "I agree ✅" },
  decline: { id: "consent_no", title: "I don't agree" },
} as const;

export function consentText(coachName: string): string {
  return [
    `Hi! 👋 I'm ${coachName}'s digital assistant. I'm an AI bot that works by ${coachName}'s method, under their supervision.`,
    "",
    "Before we start, please know:",
    "• To coach you I'll collect and keep personal information, including health information (age, weight, injuries, medical conditions, nutrition and training).",
    `• It is used only for your coaching and is stored encrypted. ${coachName} can see it too.`,
    "• To run the service it is also processed by providers abroad: Anthropic (the AI model), OpenAI (search and transcription) and Meta (WhatsApp).",
    "• I'm not a doctor and I don't replace medical advice.",
    "• You don't have to share this information. At any time you can ask to see it or delete it: just write \"delete my data\".",
    "",
    "Do you agree? Reply *I agree* to start, or *I don't agree* if not.",
  ].join("\n");
}

export const CONSENT_DECLINED_TEXT =
  "No problem, we won't keep or process any information. If you change your mind, just write *I agree* 🙂";

const ACCEPT = new Set([
  "i agree ✅",
  "yes i agree",
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

// normalize() drops apostrophes, so "I don't agree" arrives as "i dont agree".
const DECLINE = new Set(["לא מאשר", "לא מאשרת", "לא מאשר/ת", "לא", "2", "no", "i dont agree", "i do not agree", "decline"]);

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
  "To permanently delete all your information (profile, history, plans and chats), write: *delete permanently*\nThis is final and can't be undone.";
export const DELETE_DONE_TEXT = "All your information has been deleted. Thanks for being with us, and if you want to come back, just write 💪";
