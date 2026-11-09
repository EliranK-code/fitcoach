import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { REMINDER_KINDS, type LoggedExercise, type PlannedDay, type ReminderKind } from "../db/schema";
import type { Embedder } from "../knowledge/embeddings";
import type { CoachKnowledge } from "../knowledge/schema";
import { searchKnowledge } from "../knowledge/store";
import type { BetaTool } from "../llm/client";
import {
  ACTIVITY,
  applyProfileUpdate,
  EQUIPMENT,
  EXPERIENCE,
  GOALS,
  isMinor,
  missingOnboardingFields,
  PROFILE_FIELD_KEYS,
  ProfileValueError,
  SEXES,
  type ClientProfile,
} from "../profile";
import { saveProfile, setClientFlags, type ClientRow } from "../repos/clients";
import { ALERT_TYPES, createAlert, SEVERITIES, SYSTEM_ALERT_TYPES, type AlertType, type Severity } from "../repos/ops";
import {
  addMeal,
  addWeight,
  addWorkout,
  getActiveMealPlan,
  getActiveWorkoutPlan,
  listMeals,
  listWeights,
  listWorkouts,
  saveMealPlan,
  saveWorkoutPlan,
} from "../repos/tracking";
import { calorieFloor, MAX_DAILY_CALORIES } from "../safety/calories";
import { containsNutritionNumbers } from "../safety/outputGuards";
import type { TenantContext } from "../tenancy";
import { isValidTime } from "../reminders/schedule";
import { disableClientReminders, setClientReminders, type ReminderSpec } from "../reminders/store";
import { addDays, isIsoDate, localStamp } from "../time";

export type TurnEvent =
  | { type: "tool"; name: string; input: unknown; ok: boolean; result: string }
  | { type: "alert"; alertType: AlertType; severity: Severity; source: string; summary: string; deduped: boolean }
  | { type: "epoch"; action: "created" | "rolled_over"; reason: string }
  | { type: "guard"; detail: string }
  | { type: "refusal"; category: string | null }
  | { type: "usage"; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

/** Mutable state for one inbound message; tool handlers update the client and profile in place. */
export interface TurnContext {
  db: Db;
  t: TenantContext;
  cfg: AppConfig;
  client: ClientRow;
  profile: ClientProfile;
  knowledge: CoachKnowledge;
  embedder: Embedder | null;
  today: string;
  events: TurnEvent[];
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

// Strict tool use: every property is required and additionalProperties is false, so the arguments always
// match the schema. Optional values use sentinels (0 = unknown, "" = none) instead of optional fields.
const obj = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const dateProp = { type: "string", description: "Date as YYYY-MM-DD in the client's local time." };

export const TOOLS: BetaTool[] = [
  {
    name: "update_client_profile",
    description: `Save information the client shared about themselves. Call it as soon as you learn something new or changed.
Value formats per field:
- sex: ${SEXES.join(" | ")}
- goal: ${GOALS.join(" | ")} (put nuances in goalDetails)
- experience: ${EXPERIENCE.join(" | ")}
- equipment: ${EQUIPMENT.join(" | ")} (details in equipmentDetails)
- activityLevel (daily activity outside training): ${ACTIVITY.join(" | ")}
- age, heightCm, trainingDaysPerWeek, sessionMinutes: whole numbers; weightKg: number
- injuries, medicalConditions, medications, dietaryPreferences, dietaryRestrictions, allergies: lists. Send the COMPLETE current list as items separated by ";" (it replaces the stored list). Send "none" when the client has none.
- notes: one lasting insight (what works, what doesn't, preferences); appended to the client's notes.
- name, goalDetails, availableDays, equipmentDetails: free text.`,
    strict: true,
    input_schema: obj({
      updates: {
        type: "array",
        items: obj({
          field: { type: "string", enum: PROFILE_FIELD_KEYS },
          value: { type: "string" },
        }),
      },
    }),
  },
  {
    name: "log_weight",
    description: "Record a body-weight measurement the client reported.",
    strict: true,
    input_schema: obj({ weight_kg: { type: "number" }, date: dateProp }),
  },
  {
    name: "log_meal",
    description:
      "Record a meal the client ate. Pass estimated_calories and estimated_protein_g only if the coach's approach uses numbers and the client has no eating-disorder flag; otherwise pass 0.",
    strict: true,
    input_schema: obj({
      date: dateProp,
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "other"] },
      description: { type: "string" },
      estimated_calories: { type: "integer", description: "0 if unknown or not estimating." },
      estimated_protein_g: { type: "integer", description: "0 if unknown or not estimating." },
    }),
  },
  {
    name: "log_workout",
    description:
      "Record a workout the client did. The result includes the previous numbers for the same exercises, to guide progression.",
    strict: true,
    input_schema: obj({
      date: dateProp,
      title: { type: "string" },
      duration_min: { type: "integer", description: "0 if unknown." },
      exercises: {
        type: "array",
        items: obj({
          name: { type: "string" },
          sets: { type: "integer" },
          reps: { type: "integer", description: "Reps per set (average if they varied)." },
          weight_kg: { type: "number", description: "0 for bodyweight or unknown." },
        }),
      },
      notes: { type: "string", description: '"" if none.' },
    }),
  },
  {
    name: "get_client_history",
    description: "Read the client's logged history: weights, meals, workouts, or their current plans.",
    strict: true,
    input_schema: obj({
      kind: { type: "string", enum: ["weights", "meals", "workouts", "plans"] },
      days: { type: "integer", description: "How many days back to look (ignored for plans)." },
    }),
  },
  {
    name: "save_meal_plan",
    description:
      "Save a personalized meal plan before presenting it (also each time you adjust it). daily_calories is your internal estimate of the plan's total and is checked against the safe floor; it is required even when numbers aren't shown to the client. plan_text is exactly what the client will see, WhatsApp-formatted.",
    strict: true,
    input_schema: obj({
      plan_text: { type: "string" },
      daily_calories: { type: "integer" },
      protein_g: { type: "integer", description: "Estimated daily protein; 0 if not estimated." },
      show_numbers_to_client: { type: "boolean" },
    }),
  },
  {
    name: "save_workout_plan",
    description:
      "Save a personalized training plan before presenting it (also each time you adjust it). plan_text is what the client will see, WhatsApp-formatted; days holds the structured version used to track progression.",
    strict: true,
    input_schema: obj({
      plan_text: { type: "string" },
      days: {
        type: "array",
        items: obj({
          label: { type: "string" },
          exercises: {
            type: "array",
            items: obj({
              name: { type: "string" },
              sets: { type: "integer" },
              reps: { type: "string", description: 'Target reps or range, e.g. "8-10".' },
              target_weight_kg: { type: "number", description: "0 for bodyweight or to be found in the first session." },
              notes: { type: "string", description: '"" if none.' },
            }),
          },
        }),
      },
      progression_rule: { type: "string", description: "How to progress, e.g. double progression." },
    }),
  },
  {
    name: "search_coach_knowledge",
    description: "Search the coach's documents (programs, menus, guides) for passages relevant to a question.",
    strict: true,
    input_schema: obj({ query: { type: "string" } }),
  },
  {
    name: "set_reminder_preferences",
    description:
      "Save which proactive reminders the client wants. Send the COMPLETE set; it replaces the previous one. days: 0=Sunday … 6=Saturday. time: HH:MM in the client's local time. kinds: weigh_in (weigh-in), workout (training days), checkin (weekly check-in). If the client doesn't want any proactive messages, send opt_out_all=true and an empty list.",
    strict: true,
    input_schema: obj({
      opt_out_all: { type: "boolean" },
      reminders: {
        type: "array",
        items: obj({
          kind: { type: "string", enum: [...REMINDER_KINDS] },
          days: { type: "array", items: { type: "integer" } },
          time: { type: "string", description: "HH:MM, 24-hour." },
        }),
      },
    }),
  },
  {
    name: "escalate_to_coach",
    description:
      "Put something in the coach's 'needs attention' queue: a question you can't answer from the coach's knowledge, or a safety concern. Tell the client you're checking with the coach.",
    strict: true,
    input_schema: obj({
      type: { type: "string", enum: ALERT_TYPES.filter((t) => !SYSTEM_ALERT_TYPES.has(t)) },
      severity: { type: "string", enum: [...SEVERITIES] },
      summary: { type: "string", description: "One or two sentences for the coach, in Hebrew." },
      client_question: { type: "string", description: 'The client\'s question in their words; "" if not a question.' },
    }),
  },
];

const ok = (content: string): ToolOutcome => ({ content });
const fail = (content: string): ToolOutcome => ({ content, isError: true });

function resolveDate(ctx: TurnContext, raw: string): string | null {
  const value = raw.trim().toLowerCase() === "today" ? ctx.today : raw.trim();
  if (!isIsoDate(value)) return null;
  if (value > addDays(ctx.today, 1)) return null;
  return value;
}

async function raiseAlert(
  ctx: TurnContext,
  type: AlertType,
  severity: Severity,
  source: "model" | "detector" | "system",
  summary: string,
  question: string | null = null,
): Promise<boolean> {
  const res = await createAlert(ctx.db, ctx.t, { clientId: ctx.client.id, type, severity, source, summary, question });
  ctx.events.push({ type: "alert", alertType: type, severity, source, summary, deduped: res.deduped });
  if (type === "eating_disorder" && !ctx.client.flags.eatingDisorderRisk) {
    ctx.client = await setClientFlags(ctx.db, ctx.t, ctx.client, { eatingDisorderRisk: true });
  }
  if (type === "minor" && !ctx.client.flags.minor) {
    ctx.client = await setClientFlags(ctx.db, ctx.t, ctx.client, { minor: true });
  }
  return !res.deduped;
}

function floorFor(ctx: TurnContext) {
  return calorieFloor(ctx.profile, ctx.t.settings, { minor: Boolean(ctx.client.flags.minor) || isMinor(ctx.profile) });
}

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

const handlers: Record<string, (ctx: TurnContext, input: Input) => Promise<ToolOutcome>> = {
  async update_client_profile(ctx, input) {
    const updates = Array.isArray(input.updates) ? (input.updates as { field: string; value: string }[]) : [];
    const saved: string[] = [];
    const errors: string[] = [];
    let profile = ctx.profile;
    for (const u of updates) {
      try {
        profile = applyProfileUpdate(profile, u.field, str(u.value), ctx.today);
        saved.push(u.field);
      } catch (err) {
        if (err instanceof ProfileValueError) errors.push(err.message);
        else throw err;
      }
    }
    if (saved.length) {
      ctx.profile = profile;
      await saveProfile(ctx.db, ctx.t, ctx.client.id, profile);
    }
    if (saved.includes("age") && isMinor(profile)) {
      await raiseAlert(ctx, "minor", "medium", "system", `The client is ${profile.age} years old (a minor).`);
    }
    const missing = missingOnboardingFields(profile).map((f) => f.key);
    const floor = floorFor(ctx);
    const parts = [
      saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing saved.",
      errors.length ? `Rejected: ${errors.join("; ")}.` : "",
      missing.length ? `Still missing for onboarding: ${missing.join(", ")}.` : "Onboarding profile is complete.",
      `Safe calorie floor now: ${floor.floor} kcal/day.`,
    ];
    return { content: parts.filter(Boolean).join(" "), isError: saved.length === 0 && errors.length > 0 };
  },

  async log_weight(ctx, input) {
    const weight = Math.round(num(input.weight_kg) * 10) / 10;
    const date = resolveDate(ctx, str(input.date));
    if (!date) return fail("Invalid date: use YYYY-MM-DD, not in the future.");
    if (!(weight >= 25 && weight <= 350)) return fail(`Weight ${weight} kg is outside the plausible range; confirm with the client.`);
    const previous = (await listWeights(ctx.db, ctx.t, ctx.client.id)).filter((w) => w.measuredOn <= date).at(-1);
    await addWeight(ctx.db, ctx.t, ctx.client.id, weight, date);
    if (date >= ctx.today) {
      ctx.profile = { ...ctx.profile, weightKg: weight };
      await saveProfile(ctx.db, ctx.t, ctx.client.id, ctx.profile);
    }
    if (ctx.client.flags.eatingDisorderRisk) return ok("Logged. (Eating-disorder flag: don't discuss numbers or changes.)");
    if (!previous) return ok(`Logged ${weight} kg on ${date}. First measurement on record.`);
    const delta = Math.round((weight - previous.weightKg) * 10) / 10;
    return ok(`Logged ${weight} kg on ${date}. Previous: ${previous.weightKg} kg on ${previous.measuredOn} (change ${delta >= 0 ? "+" : ""}${delta} kg).`);
  },

  async log_meal(ctx, input) {
    const date = resolveDate(ctx, str(input.date));
    if (!date) return fail("Invalid date: use YYYY-MM-DD, not in the future.");
    const description = str(input.description).trim();
    if (!description) return fail("description is empty");
    const hideNumbers = Boolean(ctx.client.flags.eatingDisorderRisk);
    const cal = num(input.estimated_calories);
    const protein = num(input.estimated_protein_g);
    await addMeal(ctx.db, ctx.t, ctx.client.id, {
      eatenOn: date,
      mealType: str(input.meal_type),
      description: description.slice(0, 1000),
      estCalories: !hideNumbers && cal > 0 && cal < 5000 ? Math.round(cal) : null,
      estProteinG: !hideNumbers && protein > 0 && protein < 400 ? Math.round(protein) : null,
    });
    return ok(`Meal logged for ${date}.`);
  },

  async log_workout(ctx, input) {
    const date = resolveDate(ctx, str(input.date));
    if (!date) return fail("Invalid date: use YYYY-MM-DD, not in the future.");
    const exercises: LoggedExercise[] = (Array.isArray(input.exercises) ? (input.exercises as Input[]) : []).map((e) => ({
      name: str(e.name).trim(),
      sets: Math.max(0, Math.round(num(e.sets))),
      reps: Math.max(0, Math.round(num(e.reps))),
      weightKg: Math.max(0, Math.round(num(e.weight_kg) * 10) / 10),
    }));
    const history = await listWorkouts(ctx.db, ctx.t, ctx.client.id);
    const duration = Math.round(num(input.duration_min));
    await addWorkout(ctx.db, ctx.t, ctx.client.id, {
      performedOn: date,
      title: str(input.title).trim() || "Workout",
      durationMin: duration > 0 ? duration : null,
      exercises,
      notes: str(input.notes).trim() || null,
    });
    const comparisons: string[] = [];
    for (const ex of exercises) {
      const prev = [...history]
        .reverse()
        .flatMap((w) => w.exercises.filter((p) => p.name.trim().toLowerCase() === ex.name.toLowerCase()).map((p) => ({ ...p, on: w.performedOn })))
        .at(0);
      if (prev) comparisons.push(`${ex.name}: last time ${prev.sets}x${prev.reps} @ ${prev.weightKg} kg (${prev.on})`);
    }
    return ok(`Workout logged for ${date}.${comparisons.length ? ` Previous numbers: ${comparisons.join("; ")}.` : " No earlier data for these exercises."}`);
  },

  async get_client_history(ctx, input) {
    const kind = str(input.kind);
    const days = Math.min(Math.max(Math.round(num(input.days)) || 30, 1), 365);
    const since = addDays(ctx.today, -days);
    const hideNumbers = Boolean(ctx.client.flags.eatingDisorderRisk);
    if (kind === "weights") {
      if (hideNumbers) return ok("Hidden: eating-disorder flag is active. Don't discuss weight numbers.");
      const rows = await listWeights(ctx.db, ctx.t, ctx.client.id, since);
      return ok(rows.length ? rows.map((r) => `${r.measuredOn}: ${r.weightKg} kg`).join("\n") : `No weights in the last ${days} days.`);
    }
    if (kind === "meals") {
      const rows = await listMeals(ctx.db, ctx.t, ctx.client.id, since);
      if (!rows.length) return ok(`No meals logged in the last ${days} days.`);
      return ok(
        rows
          .slice(-60)
          .map((r) => {
            const nums = !hideNumbers && r.estCalories ? ` (~${r.estCalories} kcal${r.estProteinG ? `, ${r.estProteinG}g protein` : ""})` : "";
            return `${r.eatenOn} ${r.mealType}: ${r.description}${nums}`;
          })
          .join("\n"),
      );
    }
    if (kind === "workouts") {
      const rows = await listWorkouts(ctx.db, ctx.t, ctx.client.id, since);
      if (!rows.length) return ok(`No workouts logged in the last ${days} days.`);
      return ok(
        rows
          .slice(-30)
          .map((w) => `${w.performedOn} ${w.title}${w.durationMin ? ` (${w.durationMin} min)` : ""}: ${w.exercises.map((e) => `${e.name} ${e.sets}x${e.reps}@${e.weightKg}kg`).join(", ")}${w.notes ? ` | ${w.notes}` : ""}`)
          .join("\n"),
      );
    }
    if (kind === "plans") {
      const meal = await getActiveMealPlan(ctx.db, ctx.t, ctx.client.id);
      const workout = await getActiveWorkoutPlan(ctx.db, ctx.t, ctx.client.id);
      return ok(
        [
          meal ? `Meal plan v${meal.version}${hideNumbers ? "" : ` (~${meal.dailyCalories} kcal internal estimate)`}:\n${meal.planText}` : "No meal plan yet.",
          workout ? `Workout plan v${workout.version} (progression: ${workout.progressionRule}):\n${workout.planText}` : "No workout plan yet.",
        ].join("\n\n"),
      );
    }
    return fail(`Unknown kind ${kind}`);
  },

  async save_meal_plan(ctx, input) {
    if (ctx.client.flags.eatingDisorderRisk) {
      return fail(
        "Not saved: this client has an eating-disorder risk flag. Don't create meal plans; support them without numbers and suggest a professional. The coach has been alerted.",
      );
    }
    const planText = str(input.plan_text).trim();
    const daily = Math.round(num(input.daily_calories));
    if (!planText) return fail("plan_text is empty");
    const floor = floorFor(ctx);
    if (!(daily > 0) || daily > MAX_DAILY_CALORIES) return fail(`daily_calories ${daily} is not a plausible estimate.`);
    if (daily < floor.floor) {
      return fail(
        `Rejected: ${daily} kcal is below this client's safe floor of ${floor.floor} kcal/day (${floor.explanation}). Rebuild the plan at or above the floor.`,
      );
    }
    let showNumbers = Boolean(input.show_numbers_to_client);
    if (!ctx.knowledge.nutrition.showNumbersToClients) showNumbers = false;
    if (!showNumbers && containsNutritionNumbers(planText)) {
      return fail("Rejected: plan_text shows calorie or macro numbers, but numbers must not be shown to this client. Remove them and save again.");
    }
    const protein = Math.round(num(input.protein_g));
    const version = await saveMealPlan(ctx.db, ctx.t, ctx.client.id, {
      planText,
      dailyCalories: daily,
      proteinG: protein > 0 ? protein : null,
      showNumbers,
    });
    return ok(`Meal plan v${version} saved. Present it to the client now.`);
  },

  async save_workout_plan(ctx, input) {
    const planText = str(input.plan_text).trim();
    if (!planText) return fail("plan_text is empty");
    const days: PlannedDay[] = (Array.isArray(input.days) ? (input.days as Input[]) : []).map((d) => ({
      label: str(d.label),
      exercises: (Array.isArray(d.exercises) ? (d.exercises as Input[]) : []).map((e) => ({
        name: str(e.name).trim(),
        sets: Math.max(1, Math.round(num(e.sets))),
        reps: str(e.reps),
        targetWeightKg: Math.max(0, num(e.target_weight_kg) || 0),
        notes: str(e.notes),
      })),
    }));
    if (days.length === 0) return fail("days is empty");

    // The coach's "never program these" list is enforced here, not just in the prompt. Only the structured
    // exercise names are checked: plan_text may legitimately say "instead of X we do Y".
    const programmed = days.flatMap((d) => d.exercises.map((e) => e.name.toLowerCase()));
    const violations = ctx.knowledge.training.avoidedExercises.filter((a) =>
      [a.name, ...a.aliases]
        .map((n) => n.toLowerCase().trim())
        .filter(Boolean)
        .some((n) => programmed.some((p) => p.includes(n))),
    );
    if (violations.length) {
      return fail(
        `Rejected: the plan includes exercises this coach avoids: ${violations
          .map((v) => `${v.name}${v.alternative ? ` (use ${v.alternative})` : ""}`)
          .join("; ")}. Replace them and save again.`,
      );
    }
    const version = await saveWorkoutPlan(ctx.db, ctx.t, ctx.client.id, {
      planText,
      days,
      progressionRule: str(input.progression_rule).trim(),
    });
    return ok(`Workout plan v${version} saved. Present it to the client now.`);
  },

  async search_coach_knowledge(ctx, input) {
    const query = str(input.query).trim();
    if (!query) return fail("query is empty");
    const hits = await searchKnowledge(ctx.db, ctx.t, query, ctx.embedder, 5);
    if (!hits.length) return ok("No matching passages in the coach's documents.");
    return ok(hits.map((h, i) => `[${i + 1}] from "${h.documentTitle}":\n${h.content}`).join("\n\n"));
  },

  async set_reminder_preferences(ctx, input) {
    if (input.opt_out_all === true) {
      ctx.client = await setClientFlags(ctx.db, ctx.t, ctx.client, { remindersOptOut: true });
      await disableClientReminders(ctx.db, ctx.t, ctx.client.id);
      return ok("All proactive reminders are off for this client.");
    }
    const raw = Array.isArray(input.reminders) ? (input.reminders as Input[]) : [];
    const specs: ReminderSpec[] = [];
    const errors: string[] = [];
    for (const r of raw) {
      const kind = str(r.kind) as ReminderKind;
      const days = (Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      const time = str(r.time).trim();
      if (!REMINDER_KINDS.includes(kind)) errors.push(`unknown kind ${kind}`);
      else if (days.length === 0) errors.push(`${kind}: no valid days`);
      else if (!isValidTime(time)) errors.push(`${kind}: time must be HH:MM`);
      else specs.push({ kind, days, time });
    }
    if (errors.length && specs.length === 0) return fail(`Nothing saved: ${errors.join("; ")}`);
    if (ctx.client.flags.remindersOptOut) ctx.client = await setClientFlags(ctx.db, ctx.t, ctx.client, { remindersOptOut: undefined });
    const rows = await setClientReminders(ctx.db, ctx.t, ctx.cfg, ctx.client.id, specs, new Date());
    const tz = ctx.t.settings.timezone ?? ctx.cfg.TIMEZONE;
    const summary = rows
      .map((r) => {
        const next = r.nextRunAt ? localStamp(r.nextRunAt, tz) : "none in the next two weeks (all chosen times fall in quiet hours or Shabbat)";
        return `${r.kind} on days ${r.days.join(",")} at ${r.time}, next: ${next}`;
      })
      .join("; ");
    const notes = [
      rows.length ? `Saved: ${summary}.` : "Saved: no reminders.",
      errors.length ? `Rejected: ${errors.join("; ")}.` : "",
      "Reminders are not sent during quiet hours or (by default) on Shabbat.",
      ctx.client.channel !== "whatsapp" ? "Note: this client isn't on WhatsApp, so reminders won't actually be sent." : "",
    ];
    return ok(notes.filter(Boolean).join(" "));
  },

  async escalate_to_coach(ctx, input) {
    const type = str(input.type) as AlertType;
    const severity = str(input.severity) as Severity;
    const question = str(input.client_question).trim() || null;
    const created = await raiseAlert(ctx, type, severity, "model", str(input.summary).trim() || "(no summary)", question);
    return ok(created ? "The coach has been notified." : "The coach was already notified about this recently.");
  },
};

export async function runTool(ctx: TurnContext, name: string, input: unknown): Promise<ToolOutcome> {
  const handler = handlers[name];
  const outcome = handler ? await handler(ctx, (input ?? {}) as Input) : fail(`Unknown tool ${name}`);
  ctx.events.push({ type: "tool", name, input, ok: !outcome.isError, result: outcome.content });
  return outcome;
}

export { raiseAlert };
