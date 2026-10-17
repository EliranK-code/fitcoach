// Hebrew labels and formatting shared by pages and components.

export const ALERT_TYPE_LABEL: Record<string, string> = {
  unknown_question: "שאלה שהבוט לא ידע",
  medical: "רפואי",
  eating_disorder: "סימני הפרעת אכילה",
  minor: "קטין/ה",
  mental_health: "מצוקה נפשית",
  substances: "חומרים מסוכנים",
  paused_message: "הודעה בזמן השהיה",
  bot_error: "תקלה בבוט",
  rate_limited: "יותר מדי הודעות",
  other: "אחר",
};

export const USAGE_KIND_LABEL: Record<string, string> = {
  chat: "שיחות",
  summary: "סיכומים",
  ingest: "עיבוד מסמכים",
  embedding: "חיפוש",
  transcription: "תמלול",
  message_in: "הודעות נכנסות",
  message_out: "הודעות יוצאות",
  template: "תבניות",
};

export const SEVERITY_LABEL: Record<string, string> = { urgent: "דחוף", high: "גבוה", medium: "בינוני", low: "נמוך" };
export const SEVERITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export const SOURCE_LABEL: Record<string, string> = { model: "הבוט", detector: "גלאי אוטומטי", system: "מערכת" };

export const CONSENT_LABEL: Record<string, string> = { granted: "אישר/ה", pending: "ממתין לאישור", declined: "סירב/ה" };

export const CHANNEL_LABEL: Record<string, string> = { whatsapp: "וואטסאפ", cli: "טרמינל", playground: "מגרש משחקים" };

export const DELIVERY_LABEL: Record<string, string> = { sent: "נשלח", delivered: "נמסר", read: "נקרא", failed: "נכשל" };

export const GOAL_LABEL: Record<string, string> = {
  fat_loss: "ירידה במשקל",
  muscle_gain: "עלייה במסת שריר",
  strength: "כוח",
  endurance: "סיבולת",
  health: "בריאות כללית",
  other: "אחר",
};

export const NUTRITION_APPROACH_LABEL: Record<string, string> = {
  calorie_counting: "ספירת קלוריות",
  no_counting: "בלי ספירה",
  intermittent_fasting: "צום לסירוגין",
  vegan: "טבעוני",
  vegetarian: "צמחוני",
  low_carb: "דל פחמימות",
  custom: "גישה אחרת",
};

export const TONE_LABEL: Record<string, string> = { tough: "קשוח", warm: "חם", humorous: "הומוריסטי", professional: "מקצועי" };

export const REMINDER_KIND_LABEL: Record<string, string> = {
  weigh_in: "שקילה",
  workout: "יום אימון",
  checkin: "check-in שבועי",
  inactivity: "check-in אחרי חוסר פעילות",
};

export const DAY_NAMES = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];

export function formatDateTime(date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(date));
}

export function formatRelative(date: Date | string | null, now = new Date()): string {
  if (!date) return "—";
  const diff = now.getTime() - new Date(date).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק'`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שע'`;
  const days = Math.round(hours / 24);
  return days === 1 ? "אתמול" : `לפני ${days} ימים`;
}
