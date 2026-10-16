import type { CoachSettings } from "../db/schema.js";
import type { ClientProfile } from "../profile.js";

/** Platform minimums. A coach may raise these in settings but never lower them. */
export const PLATFORM_FLOOR = { female: 1200, male: 1500, unknown: 1500 } as const;
/** Maximum daily deficit below estimated TDEE. */
export const MAX_DEFICIT = 0.25;
export const MAX_DAILY_CALORIES = 6000;

const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 } as const;

/** Mifflin-St Jeor resting metabolic rate; null until the inputs are known. */
export function estimateBmr(p: ClientProfile): number | null {
  if (p.weightKg === undefined || p.heightCm === undefined || p.age === undefined) return null;
  const sexOffset = p.sex === "male" ? 5 : p.sex === "female" ? -161 : -78;
  return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + sexOffset;
}

function activityFactor(p: ClientProfile): number {
  if (p.activityLevel) return ACTIVITY_FACTORS[p.activityLevel];
  const days = p.trainingDaysPerWeek ?? 0;
  if (days >= 6) return 1.75;
  if (days >= 4) return 1.6;
  if (days >= 2) return 1.45;
  return 1.3;
}

export function estimateTdee(p: ClientProfile): number | null {
  const bmr = estimateBmr(p);
  return bmr === null ? null : Math.round(bmr * activityFactor(p));
}

export interface CalorieFloor {
  floor: number;
  tdee: number | null;
  explanation: string;
}

export function calorieFloor(p: ClientProfile, settings: CoachSettings, opts: { minor: boolean }): CalorieFloor {
  const female = Math.max(PLATFORM_FLOOR.female, settings.calorieFloorFemale ?? 0);
  const male = Math.max(PLATFORM_FLOOR.male, settings.calorieFloorMale ?? 0);
  const sexFloor = p.sex === "female" ? female : p.sex === "male" ? male : Math.max(male, PLATFORM_FLOOR.unknown);
  const tdee = estimateTdee(p);

  if (opts.minor) {
    const floor = Math.max(sexFloor + 300, tdee ?? 0);
    return { floor, tdee, explanation: "client is a minor: no calorie deficit allowed (floor = estimated maintenance)" };
  }
  if (tdee === null) {
    return { floor: sexFloor, tdee, explanation: "absolute minimum; TDEE unknown until age, height and weight are collected" };
  }
  const deficitFloor = Math.round(tdee * (1 - MAX_DEFICIT));
  return {
    floor: Math.max(sexFloor, deficitFloor),
    tdee,
    explanation: `max(${sexFloor} absolute minimum, ${deficitFloor} = estimated TDEE ${tdee} minus ${MAX_DEFICIT * 100}%)`,
  };
}
