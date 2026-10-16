import type { ReminderMessageKind, ReminderSettings } from "../db/schema";
import { addDays } from "../time";

// Time math for proactive reminders, in the coach's IANA time zone, without a date library.

export const DEFAULT_REMINDER_TEXTS: Record<ReminderMessageKind, string> = {
  weigh_in: "בוקר טוב {name}! ⚖️ זה הזמן לשקילה. שלח/י לי את המספר כשיש 💪",
  workout: "היי {name}, היום יום אימון! 🔥 עדכן/י אותי איך היה כשסיימת",
  checkin: "היי {name}! איך עבר השבוע? ספר/י לי מה הלך טוב ומה היה קשה 🙂",
  inactivity: "היי {name}, מה שלומך? 🙂 לא שמעתי ממך כמה ימים. אני כאן אם צריך משהו, גם אם זה רק להתחיל מחדש בקטן",
};

export interface ResolvedReminderSettings {
  quietStart: string;
  quietEnd: string;
  skipShabbat: boolean;
  inactivityDays: number;
  texts: Record<ReminderMessageKind, string>;
  templates: NonNullable<ReminderSettings["templates"]>;
}

export function resolveReminderSettings(s: ReminderSettings | undefined): ResolvedReminderSettings {
  return {
    quietStart: s?.quietStart ?? "21:30",
    quietEnd: s?.quietEnd ?? "08:00",
    skipShabbat: s?.skipShabbat ?? true,
    inactivityDays: s?.inactivityDays ?? 4,
    texts: { ...DEFAULT_REMINDER_TEXTS, ...Object.fromEntries(Object.entries(s?.texts ?? {}).filter(([, v]) => v?.trim())) },
    templates: s?.templates ?? {},
  };
}

/** Fills {name}; without a name the placeholder (and the space before it) disappears. */
export function fillReminderText(text: string, firstName: string | null): string {
  return text.replace(/\s?\{name\}/g, firstName ? ` ${firstName}` : "").trim();
}

export function isValidTime(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return Boolean(m) && Number(m![1]) < 24 && Number(m![2]) < 60;
}

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Local wall time minus UTC, in ms, for the given instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a local date and time in a zone (a time skipped by DST resolves to just after the jump). */
export function zonedTimeToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

export function localInfo(date: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const p = zonedParts(date, timeZone);
  const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return {
    date: iso,
    time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
    weekday: new Date(`${iso}T12:00:00Z`).getUTCDay(),
  };
}

/**
 * Quiet hours (default 21:30–08:00) and, unless the coach turned it off, Shabbat: Friday 15:00 to
 * Saturday 21:00 local time. A fixed, conservative window rather than exact candle-lighting times.
 */
export function isQuietTime(at: Date, timeZone: string, s: Pick<ResolvedReminderSettings, "quietStart" | "quietEnd" | "skipShabbat">): boolean {
  const { time, weekday } = localInfo(at, timeZone);
  const quiet = s.quietStart > s.quietEnd ? time >= s.quietStart || time < s.quietEnd : time >= s.quietStart && time < s.quietEnd;
  if (quiet) return true;
  if (s.skipShabbat && ((weekday === 5 && time >= "15:00") || (weekday === 6 && time < "21:00"))) return true;
  return false;
}

/** The next allowed occurrence after `after` on one of `days` (0 = Sunday) at `time`, or null within two weeks. */
export function nextOccurrence(
  rule: { days: number[]; time: string },
  after: Date,
  timeZone: string,
  s: Pick<ResolvedReminderSettings, "quietStart" | "quietEnd" | "skipShabbat">,
): Date | null {
  const start = localInfo(after, timeZone).date;
  for (let k = 0; k <= 14; k++) {
    // Walk calendar dates, not 24-hour steps, so a DST change can't skip or repeat a day.
    const date = addDays(start, k);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!rule.days.includes(weekday)) continue;
    const at = zonedTimeToUtc(date, rule.time, timeZone);
    if (at <= after || isQuietTime(at, timeZone, s)) continue;
    return at;
  }
  return null;
}
