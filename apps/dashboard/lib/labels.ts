// Hebrew labels and formatting shared by pages and components.

export const ALERT_TYPE_LABEL: Record<string, string> = {
  unknown_question: "Question the bot couldn't answer",
  medical: "Medical",
  eating_disorder: "Eating-disorder signs",
  minor: "Minor",
  mental_health: "Mental distress",
  substances: "Dangerous substances",
  paused_message: "Message while paused",
  bot_error: "Bot error",
  rate_limited: "Too many messages",
  spend_cap: "Spend cap",
  join_request: "Join request",
  other: "Other",
};

export const USAGE_KIND_LABEL: Record<string, string> = {
  chat: "Chats",
  summary: "Summaries",
  ingest: "Document processing",
  embedding: "Search",
  transcription: "Transcription",
  message_in: "Incoming messages",
  message_out: "Outgoing messages",
  template: "Templates",
};

export const SEVERITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
export const SEVERITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export const SOURCE_LABEL: Record<string, string> = { model: "The bot", detector: "Automatic detector", system: "System" };

export const CONSENT_LABEL: Record<string, string> = { granted: "Agreed", pending: "Awaiting consent", declined: "Declined" };

export const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", cli: "Terminal", playground: "Playground" };

export const DELIVERY_LABEL: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" };

export const GOAL_LABEL: Record<string, string> = {
  fat_loss: "Fat loss",
  muscle_gain: "Muscle gain",
  strength: "Strength",
  endurance: "Endurance",
  health: "General health",
  other: "Other",
};

export const NUTRITION_APPROACH_LABEL: Record<string, string> = {
  calorie_counting: "Calorie counting",
  no_counting: "No counting",
  intermittent_fasting: "Intermittent fasting",
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  low_carb: "Low carb",
  custom: "Another approach",
};

export const TONE_LABEL: Record<string, string> = { tough: "Tough", warm: "Warm", humorous: "Humorous", professional: "Professional" };

export const REMINDER_KIND_LABEL: Record<string, string> = {
  weigh_in: "Weigh-in",
  workout: "Training day",
  checkin: "Weekly check-in",
  inactivity: "Check-in after inactivity",
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDateTime(date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(date));
}

export function formatRelative(date: Date | string | null, now = new Date()): string {
  if (!date) return "—";
  const diff = now.getTime() - new Date(date).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
