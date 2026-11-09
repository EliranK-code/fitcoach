// The client profile the bot builds during onboarding and keeps current. Stored encrypted as one JSON document.
// A missing field means "not asked yet"; an empty list means "asked, none" (e.g. no injuries).

export const GOALS = ["fat_loss", "muscle_gain", "strength", "endurance", "health", "other"] as const;
export const SEXES = ["male", "female", "other"] as const;
export const EXPERIENCE = ["beginner", "intermediate", "advanced"] as const;
export const EQUIPMENT = ["gym", "home", "both", "none"] as const;
export const ACTIVITY = ["sedentary", "light", "moderate", "active", "very_active"] as const;

export interface ProfileNote {
  date: string;
  text: string;
}

export interface ClientProfile {
  name?: string;
  age?: number;
  sex?: (typeof SEXES)[number];
  heightCm?: number;
  weightKg?: number;
  goal?: (typeof GOALS)[number];
  goalDetails?: string;
  experience?: (typeof EXPERIENCE)[number];
  trainingDaysPerWeek?: number;
  sessionMinutes?: number;
  availableDays?: string;
  equipment?: (typeof EQUIPMENT)[number];
  equipmentDetails?: string;
  activityLevel?: (typeof ACTIVITY)[number];
  injuries?: string[];
  medicalConditions?: string[];
  medications?: string[];
  dietaryPreferences?: string[];
  dietaryRestrictions?: string[];
  allergies?: string[];
  /** What worked, what didn't, preferences learned over time. Appended, never replaced. */
  notes?: ProfileNote[];
}

type FieldKind =
  | { kind: "text" }
  | { kind: "int"; min: number; max: number }
  | { kind: "number"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "list" }
  | { kind: "note" };

interface FieldDef {
  key: keyof ClientProfile;
  label: string;
  spec: FieldKind;
  /** Needed before the bot can build plans; drives the onboarding checklist. */
  onboarding: boolean;
}

export const PROFILE_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", spec: { kind: "text" }, onboarding: true },
  { key: "age", label: "Age", spec: { kind: "int", min: 5, max: 110 }, onboarding: true },
  { key: "sex", label: "Sex", spec: { kind: "enum", values: SEXES }, onboarding: true },
  { key: "heightCm", label: "Height (cm)", spec: { kind: "int", min: 100, max: 250 }, onboarding: true },
  { key: "weightKg", label: "Weight (kg)", spec: { kind: "number", min: 25, max: 350 }, onboarding: true },
  { key: "goal", label: "Goal", spec: { kind: "enum", values: GOALS }, onboarding: true },
  { key: "goalDetails", label: "Goal details", spec: { kind: "text" }, onboarding: false },
  { key: "experience", label: "Experience", spec: { kind: "enum", values: EXPERIENCE }, onboarding: true },
  { key: "trainingDaysPerWeek", label: "Training days per week", spec: { kind: "int", min: 0, max: 7 }, onboarding: true },
  { key: "sessionMinutes", label: "Minutes per session", spec: { kind: "int", min: 10, max: 300 }, onboarding: true },
  { key: "availableDays", label: "Available days and times", spec: { kind: "text" }, onboarding: false },
  { key: "equipment", label: "Equipment", spec: { kind: "enum", values: EQUIPMENT }, onboarding: true },
  { key: "equipmentDetails", label: "Equipment details", spec: { kind: "text" }, onboarding: false },
  { key: "activityLevel", label: "Daily activity level", spec: { kind: "enum", values: ACTIVITY }, onboarding: false },
  { key: "injuries", label: "Injuries and limitations", spec: { kind: "list" }, onboarding: true },
  { key: "medicalConditions", label: "Medical conditions", spec: { kind: "list" }, onboarding: true },
  { key: "medications", label: "Medications", spec: { kind: "list" }, onboarding: true },
  { key: "dietaryPreferences", label: "Dietary preferences", spec: { kind: "list" }, onboarding: true },
  { key: "dietaryRestrictions", label: "Dietary restrictions", spec: { kind: "list" }, onboarding: false },
  { key: "allergies", label: "Allergies", spec: { kind: "list" }, onboarding: true },
  { key: "notes", label: "Notes (what works and what doesn't)", spec: { kind: "note" }, onboarding: false },
];

export const PROFILE_FIELD_KEYS = PROFILE_FIELDS.map((f) => f.key) as [string, ...string[]];

const NONE_WORDS = new Set(["none", "no", "nothing", "אין", "ללא", "לא", "אין כלום", "-"]);

export class ProfileValueError extends Error {}

function parseNumber(raw: string): number {
  const match = raw.replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!match) throw new ProfileValueError(`"${raw}" is not a number`);
  return Number(match[0]);
}

/** Applies one tool-provided update (value is always a string) and returns the new profile. */
export function applyProfileUpdate(
  profile: ClientProfile,
  field: string,
  rawValue: string,
  today: string,
): ClientProfile {
  const def = PROFILE_FIELDS.find((f) => f.key === field);
  if (!def) throw new ProfileValueError(`Unknown profile field "${field}"`);
  const value = rawValue.trim();
  const next: ClientProfile = { ...profile };
  const target = next as Record<string, unknown>;

  switch (def.spec.kind) {
    case "text":
      if (!value) throw new ProfileValueError(`${field} cannot be empty`);
      target[def.key] = value.slice(0, 500);
      break;
    case "int":
    case "number": {
      const n = def.spec.kind === "int" ? Math.round(parseNumber(value)) : Math.round(parseNumber(value) * 10) / 10;
      if (n < def.spec.min || n > def.spec.max) {
        throw new ProfileValueError(`${field}=${n} is outside ${def.spec.min}-${def.spec.max}`);
      }
      target[def.key] = n;
      break;
    }
    case "enum":
      if (!def.spec.values.includes(value)) {
        throw new ProfileValueError(`${field} must be one of: ${def.spec.values.join(", ")}`);
      }
      target[def.key] = value;
      break;
    case "list":
      target[def.key] = NONE_WORDS.has(value.toLowerCase())
        ? []
        : value
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 30);
      break;
    case "note":
      if (!value) throw new ProfileValueError("note cannot be empty");
      next.notes = [...(profile.notes ?? []), { date: today, text: value.slice(0, 500) }].slice(-50);
      break;
  }
  return next;
}

export function missingOnboardingFields(profile: ClientProfile): FieldDef[] {
  return PROFILE_FIELDS.filter((f) => f.onboarding && profile[f.key] === undefined);
}

export function isOnboardingComplete(profile: ClientProfile): boolean {
  return missingOnboardingFields(profile).length === 0;
}

export function isMinor(profile: ClientProfile): boolean {
  return profile.age !== undefined && profile.age < 18;
}

/** Human-readable profile (Hebrew labels), used by the CLI and the dashboard. */
export function describeProfile(profile: ClientProfile): string {
  const lines: string[] = [];
  for (const f of PROFILE_FIELDS) {
    const v = profile[f.key];
    if (v === undefined) {
      if (f.onboarding) lines.push(`${f.label}: (not collected yet)`);
      continue;
    }
    if (f.spec.kind === "note") {
      for (const n of v as ProfileNote[]) lines.push(`Note ${n.date}: ${n.text}`);
    } else if (Array.isArray(v)) {
      lines.push(`${f.label}: ${v.length ? v.join("; ") : "none"}`);
    } else {
      lines.push(`${f.label}: ${v}`);
    }
  }
  return lines.join("\n");
}
