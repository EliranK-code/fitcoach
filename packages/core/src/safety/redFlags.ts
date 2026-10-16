import type { AlertType, Severity } from "../repos/ops";

// Deterministic backstop for the safety rules: catches red-flag phrases in client messages even if the model
// misses them. Hebrew words take prefixes (ו, ה, ב, ל, מ, ש, כ), so Hebrew patterns match substrings rather
// than whole words. Phrases are specific on purpose: Israeli slang like "קרעתי" (crushed it) or "שברתי שיא"
// (broke a record) must not trigger injury alerts.

export type RedFlagCategory =
  | "cardiac"
  | "dizziness"
  | "injury"
  | "pregnancy"
  | "medical_condition"
  | "eating_disorder"
  | "substances"
  | "self_harm"
  | "minor";

interface Rule {
  category: RedFlagCategory;
  alertType: AlertType;
  severity: Severity;
  label: string;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "self_harm",
    alertType: "mental_health",
    severity: "urgent",
    label: "self-harm or suicidal thoughts",
    patterns: [
      /להתאבד|התאבדות|לפגוע בעצמי|פוגע(?:ת)? בעצמי|לא רוצה לחיות|אין לי בשביל מה לחיות|לשים קץ/,
      /\b(?:suicid\w*|kill myself|self[- ]harm|hurt myself|end my life|don'?t want to live)\b/i,
    ],
  },
  {
    category: "cardiac",
    alertType: "medical",
    severity: "urgent",
    label: "chest pain, fainting or breathing difficulty",
    patterns: [
      /כא(?:ב|בים) ב?חזה|לחץ ב?חזה|דקירות? ב?חזה|כאב בלב|התעלפ|עילפון|איבדתי (?:את ה)?הכרה|קוצר נשימה|קשה לי לנשום|דופק (?:לא סדיר|מהיר מאוד|משתולל)|דפיקות לב/,
      /\b(?:chest (?:pain|tightness|pressure)|faint(?:ed|ing)?|passed out|short(?:ness)? of breath|can'?t breathe|irregular heart ?beat|heart palpitations)\b/i,
    ],
  },
  {
    category: "dizziness",
    alertType: "medical",
    severity: "high",
    label: "dizziness",
    patterns: [/סחרחור|מסוחרר|מסתחרר|הסתחרר|ראש מסתובב/, /\b(?:dizz(?:y|iness)|lightheaded|light-headed|vertigo)\b/i],
  },
  {
    category: "injury",
    alertType: "medical",
    severity: "high",
    label: "new injury or unusual pain",
    patterns: [
      /נפצעתי|נפצע(?:ה)? לי|פציעה חדשה|קרע ב(?:שריר|רצועה|מניסקוס|גיד)|נקרע(?:ה)? לי|שבר ב(?:יד|רגל|אצבע|צלע|כף)|שברתי את ה(?:יד|רגל|אצבע)|נקע ב|נקעתי|כאב חד|כאב חריג|כאב חזק מאוד|נפוח(?:ה)? ו?כואב|לא יכול(?:ה)? לדרוך/,
      /\b(?:i got injured|injured my|torn (?:muscle|ligament|meniscus)|sprain(?:ed)?|fractur\w+|sharp pain|severe pain|can'?t put weight on)\b/i,
    ],
  },
  {
    category: "pregnancy",
    alertType: "medical",
    severity: "medium",
    label: "pregnancy or postpartum",
    patterns: [/בהריון|בהיריון|הריון|היריון|אחרי לידה|ילדתי לפני/, /\b(?:pregnan\w*|postpartum|post-partum|gave birth)\b/i],
  },
  {
    category: "medical_condition",
    alertType: "medical",
    severity: "medium",
    label: "chronic condition or medication",
    patterns: [
      /סוכרת|אינסולין|לחץ דם גבוה|יתר לחץ דם|מחלת לב|אי ספיקת|אסתמה|אפילפסיה|בלוטת ה?תריס|כולסטרול גבוה|מחלה כרונית|כימותרפיה|סרטן|אני (?:לוקח|לוקחת|נוטל|נוטלת) תרופ|תרופות קבועות|כדורים ל/,
      /\b(?:diabet\w*|insulin|hypertension|high blood pressure|heart disease|asthma|epilep\w*|thyroid|chemotherapy|cancer|on medication|prescription)\b/i,
    ],
  },
  {
    category: "eating_disorder",
    alertType: "eating_disorder",
    severity: "high",
    label: "possible eating-disorder signs",
    patterns: [
      /הקאתי|להקיא|מקיא(?:ה)? אחרי|מכניס(?:ה)? אצבע|משלשלים|בולימיה|אנורקסיה|הפרעת אכילה|לא אכלתי כבר \S+ ימים|לא אכלתי כלום (?:כבר|כל היום|מאתמול)|צמ(?:ה)? כבר \S+ ימים|צום של \S+ ימים|שונא(?:ת)? את הגוף|מגעיל(?:ה)? את עצמי|אשמה אחרי (?:ש)?(?:אכלתי|כל ארוחה)|לשרוף כל מה שאכלתי/,
      /(?:רק|בערך)\s*[1-8]\d{2}\s*(?:קלוריות|קק"ל|קק״ל)/,
      /\b(?:purg\w*|vomit\w*|throw(?:ing)? up after|laxatives?|bulimi\w*|anorexi\w*|eating disorder|starving myself|haven'?t eaten in days|hate my body)\b/i,
      /\bonly\s*[1-8]\d{2}\s*(?:calories|kcal|cal)\b/i,
    ],
  },
  {
    category: "substances",
    alertType: "substances",
    severity: "medium",
    label: "steroids, SARMs or dangerous weight-loss substances",
    patterns: [
      /סטרואיד|סארמס|סארמז|טסטוסטרון|הורמון גדילה|קלנבוטרול|אפדרין|משתנים|שורפי שומן|כדורי הרזיה|אוזמפיק|מונג'רו/,
      /\b(?:steroids?|sarms?|dnp|clenbuterol|ephedrine|testosterone|trt|hgh|diuretics?|fat burners?|diet pills|ozempic|semaglutide|mounjaro|tirzepatide)\b/i,
    ],
  },
];

const MINOR_AGE_PATTERNS = [
  /(?:אני|אנוכי)\s+(?:בן|בת)\s+(\d{1,2})(?!\d)/,
  /\b(?:i'?m|i am)\s+(\d{1,2})(?:\s*(?:years?\s*old|yo|y\/o))?(?=\s*(?:$|[.,!?]))/i,
  /(?<!\d)(\d{1,2})\s*(?:years? old|yo\b)/i,
];
const SCHOOL_PATTERNS = [/אני ב?כיתה [א-י]['׳]?|אני בתיכון|בחטיבת ביניים|תלמיד(?:ה)? בכיתה/, /\b(?:high school|middle school|in \d{1,2}th grade)\b/i];

export interface RedFlagHit {
  category: RedFlagCategory;
  alertType: AlertType;
  severity: Severity;
  label: string;
}

export function detectRedFlags(text: string): RedFlagHit[] {
  const hits: RedFlagHit[] = [];
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      hits.push({ category: rule.category, alertType: rule.alertType, severity: rule.severity, label: rule.label });
    }
  }
  const ageMatch = MINOR_AGE_PATTERNS.map((p) => text.match(p)).find((m) => m?.[1]);
  const age = ageMatch?.[1] ? Number(ageMatch[1]) : null;
  if ((age !== null && age >= 8 && age < 18) || SCHOOL_PATTERNS.some((p) => p.test(text))) {
    hits.push({ category: "minor", alertType: "minor", severity: "medium", label: "client may be under 18" });
  }
  return hits;
}

/** The note injected into the conversation (as a system message) when the detector fires. */
export function safetyNote(hits: RedFlagHit[]): string {
  const lines = hits.map(
    (h) => `<safety_flag category="${h.category}" severity="${h.severity}">Automatic detector matched: ${h.label}.</safety_flag>`,
  );
  return [
    ...lines,
    "Follow the safety protocol for these categories in your reply. The coach has already been alerted about them, so do not call escalate_to_coach again for the same issue. If the message is clearly not about the client's own situation (e.g. a joke or a question about someone else), respond naturally.",
  ].join("\n");
}
