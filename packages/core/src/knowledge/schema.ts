import { z } from "zod";

// The structured part of a coach's knowledge base (coach.yaml). Free-form documents live alongside it
// in docs/ and are handled by the importer. Field names are English; the content is in the coach's language.

const avoidedExercise = z.object({
  name: z.string(),
  /** Other names for the same exercise (Hebrew/English/slang), used by the plan validator. */
  aliases: z.array(z.string()).default([]),
  reason: z.string().default(""),
  alternative: z.string().default(""),
});

const injuryGuideline = z.object({
  area: z.string(),
  guidance: z.string(),
  allowed: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
});

const faqEntry = z.object({ q: z.string(), a: z.string() });

export const NUTRITION_APPROACHES = [
  "calorie_counting",
  "no_counting",
  "intermittent_fasting",
  "vegan",
  "vegetarian",
  "low_carb",
  "custom",
] as const;

export const TONE_STYLES = ["tough", "warm", "humorous", "professional"] as const;

export const coachKnowledgeSchema = z.object({
  coach: z.object({
    name: z.string(),
    businessName: z.string().default(""),
    bio: z.string().default(""),
    /** Default reply language for clients who haven't written yet. */
    language: z.string().default("en"),
  }),
  tone: z.object({
    styles: z.array(z.enum(TONE_STYLES)).min(1),
    description: z.string().default(""),
    phrases: z.array(z.string()).default([]),
    emojis: z.string().default(""),
  }),
  philosophy: z.string(),
  nutrition: z.object({
    approach: z.enum(NUTRITION_APPROACHES),
    /** Whether clients see calorie/macro numbers. Even when false, plans carry an internal estimate for the safety floor. */
    showNumbersToClients: z.boolean().default(true),
    details: z.string(),
  }),
  training: z.object({
    principles: z.string(),
    preferredExercises: z.array(z.string()).default([]),
    avoidedExercises: z.array(avoidedExercise).default([]),
    samplePrograms: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
  }),
  injuries: z.array(injuryGuideline).default([]),
  supplements: z.object({
    allowed: z.array(z.string()).default([]),
    policy: z.string().default(""),
  }),
  faq: z.array(faqEntry).default([]),
  /** Topics the bot never answers itself: it says it will check and opens an alert for the coach. */
  alwaysEscalate: z.array(z.string()).default([]),
});

export type CoachKnowledge = z.infer<typeof coachKnowledgeSchema>;
export type CoachKnowledgeInput = z.input<typeof coachKnowledgeSchema>;
