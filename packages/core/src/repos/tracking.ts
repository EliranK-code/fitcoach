import { and, asc, desc, eq, gte, max } from "drizzle-orm";
import { decryptOptional, decryptText, encryptOptional, encryptText } from "../crypto.js";
import type { Db } from "../db/client.js";
import {
  mealLogs,
  mealPlans,
  weightLogs,
  workoutLogs,
  workoutPlans,
  type LoggedExercise,
  type PlannedDay,
} from "../db/schema.js";
import type { TenantContext } from "../tenancy.js";

const scope = <T extends { coachId: unknown; clientId: unknown }>(table: T, t: TenantContext, clientId: string) =>
  and(eq(table.coachId as never, t.coachId), eq(table.clientId as never, clientId));

export async function addWeight(db: Db, t: TenantContext, clientId: string, weightKg: number, measuredOn: string) {
  await db.insert(weightLogs).values({ coachId: t.coachId, clientId, weightKg, measuredOn });
}

export async function listWeights(db: Db, t: TenantContext, clientId: string, sinceDate?: string) {
  const where = sinceDate
    ? and(scope(weightLogs, t, clientId), gte(weightLogs.measuredOn, sinceDate))
    : scope(weightLogs, t, clientId);
  return db
    .select({ weightKg: weightLogs.weightKg, measuredOn: weightLogs.measuredOn })
    .from(weightLogs)
    .where(where)
    .orderBy(asc(weightLogs.measuredOn), asc(weightLogs.createdAt));
}

export async function addMeal(
  db: Db,
  t: TenantContext,
  clientId: string,
  meal: { eatenOn: string; mealType: string; description: string; estCalories: number | null; estProteinG: number | null },
) {
  await db.insert(mealLogs).values({
    coachId: t.coachId,
    clientId,
    eatenOn: meal.eatenOn,
    mealType: meal.mealType,
    descriptionEnc: encryptText(t, meal.description),
    estCalories: meal.estCalories,
    estProteinG: meal.estProteinG,
  });
}

export async function listMeals(db: Db, t: TenantContext, clientId: string, sinceDate?: string) {
  const where = sinceDate
    ? and(scope(mealLogs, t, clientId), gte(mealLogs.eatenOn, sinceDate))
    : scope(mealLogs, t, clientId);
  const rows = await db.select().from(mealLogs).where(where).orderBy(asc(mealLogs.eatenOn), asc(mealLogs.createdAt));
  return rows.map((r) => ({
    eatenOn: r.eatenOn,
    mealType: r.mealType,
    description: decryptText(t, r.descriptionEnc),
    estCalories: r.estCalories,
    estProteinG: r.estProteinG,
  }));
}

export async function addWorkout(
  db: Db,
  t: TenantContext,
  clientId: string,
  w: { performedOn: string; title: string; durationMin: number | null; exercises: LoggedExercise[]; notes: string | null },
) {
  await db.insert(workoutLogs).values({
    coachId: t.coachId,
    clientId,
    performedOn: w.performedOn,
    title: w.title,
    durationMin: w.durationMin,
    exercises: w.exercises,
    notesEnc: encryptOptional(t, w.notes),
  });
}

export async function listWorkouts(db: Db, t: TenantContext, clientId: string, sinceDate?: string) {
  const where = sinceDate
    ? and(scope(workoutLogs, t, clientId), gte(workoutLogs.performedOn, sinceDate))
    : scope(workoutLogs, t, clientId);
  const rows = await db
    .select()
    .from(workoutLogs)
    .where(where)
    .orderBy(asc(workoutLogs.performedOn), asc(workoutLogs.createdAt));
  return rows.map((r) => ({
    performedOn: r.performedOn,
    title: r.title,
    durationMin: r.durationMin,
    exercises: r.exercises,
    notes: decryptOptional(t, r.notesEnc),
  }));
}

export interface MealPlanInput {
  planText: string;
  dailyCalories: number;
  proteinG: number | null;
  showNumbers: boolean;
}

export async function saveMealPlan(db: Db, t: TenantContext, clientId: string, plan: MealPlanInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [last] = await tx.select({ v: max(mealPlans.version) }).from(mealPlans).where(scope(mealPlans, t, clientId));
    const version = (last?.v ?? 0) + 1;
    await tx.update(mealPlans).set({ status: "archived" }).where(scope(mealPlans, t, clientId));
    await tx.insert(mealPlans).values({
      coachId: t.coachId,
      clientId,
      version,
      planEnc: encryptText(t, plan.planText),
      dailyCalories: plan.dailyCalories,
      proteinG: plan.proteinG,
      showNumbers: plan.showNumbers,
    });
    return version;
  });
}

export async function getActiveMealPlan(db: Db, t: TenantContext, clientId: string) {
  const [row] = await db
    .select()
    .from(mealPlans)
    .where(and(scope(mealPlans, t, clientId), eq(mealPlans.status, "active")))
    .orderBy(desc(mealPlans.version))
    .limit(1);
  if (!row) return null;
  return {
    version: row.version,
    planText: decryptText(t, row.planEnc),
    dailyCalories: row.dailyCalories,
    proteinG: row.proteinG,
    showNumbers: row.showNumbers,
    createdAt: row.createdAt,
  };
}

export interface WorkoutPlanInput {
  planText: string;
  days: PlannedDay[];
  progressionRule: string;
}

export async function saveWorkoutPlan(db: Db, t: TenantContext, clientId: string, plan: WorkoutPlanInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ v: max(workoutPlans.version) })
      .from(workoutPlans)
      .where(scope(workoutPlans, t, clientId));
    const version = (last?.v ?? 0) + 1;
    await tx.update(workoutPlans).set({ status: "archived" }).where(scope(workoutPlans, t, clientId));
    await tx.insert(workoutPlans).values({
      coachId: t.coachId,
      clientId,
      version,
      days: plan.days,
      progressionRule: plan.progressionRule,
      planEnc: encryptText(t, plan.planText),
    });
    return version;
  });
}

export async function getActiveWorkoutPlan(db: Db, t: TenantContext, clientId: string) {
  const [row] = await db
    .select()
    .from(workoutPlans)
    .where(and(scope(workoutPlans, t, clientId), eq(workoutPlans.status, "active")))
    .orderBy(desc(workoutPlans.version))
    .limit(1);
  if (!row) return null;
  return {
    version: row.version,
    days: row.days,
    progressionRule: row.progressionRule,
    planText: decryptText(t, row.planEnc),
    createdAt: row.createdAt,
  };
}
