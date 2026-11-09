// Client-facing dates are in the coach's time zone (their setting, or TIMEZONE from the config).

/** True for a time zone the runtime knows: an IANA name such as Europe/London, or UTC. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** ICU still lists these zones under their old names; the list shows the current IANA ones (both work in Intl). */
const RENAMED_ZONES: Record<string, string> = {
  "America/Godthab": "America/Nuuk",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** UTC first, then every IANA zone the runtime knows plus the given ones (a coach's current zone), sorted. */
export function timeZoneOptions(...include: string[]): string[] {
  const known = Intl.supportedValuesOf("timeZone").map((z) => (RENAMED_ZONES[z] && isValidTimeZone(RENAMED_ZONES[z]) ? RENAMED_ZONES[z] : z));
  const zones = new Set([...known, ...include.filter(isValidTimeZone)]);
  zones.delete("UTC");
  return ["UTC", ...[...zones].sort()];
}

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return map;
}

/** "2026-10-16" in the given zone. */
export function localDate(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-16 14:05 Thu" in the given zone; prefixed to each client message so the model knows "today". */
export function localStamp(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.weekday}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime());
}
