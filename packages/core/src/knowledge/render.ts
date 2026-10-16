import type { CoachKnowledge } from "./schema.js";

const NUTRITION_LABELS: Record<CoachKnowledge["nutrition"]["approach"], string> = {
  calorie_counting: "calorie counting",
  no_counting: "no calorie counting",
  intermittent_fasting: "intermittent fasting",
  vegan: "vegan",
  vegetarian: "vegetarian",
  low_carb: "low carb",
  custom: "custom approach (see details)",
};

/** Rough token estimate for Hebrew/English mixed text; only used for sizing decisions, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/**
 * Renders the coach's structured knowledge (and, when small enough, their documents) into the cached
 * system block. Output must be deterministic for a given input: any byte change invalidates the prompt cache.
 */
export function renderCoachKnowledge(
  k: CoachKnowledge,
  version: number,
  inlineDocs: { title: string; text: string }[],
): string {
  const parts: string[] = [];
  parts.push(`<coach_knowledge version="${version}">`);
  parts.push(`# Coach: ${k.coach.name}${k.coach.businessName ? ` (${k.coach.businessName})` : ""}`);
  if (k.coach.bio) parts.push(k.coach.bio);
  parts.push(`Default language for new clients: ${k.coach.language}`);

  parts.push(`\n## Voice and tone\nStyle: ${k.tone.styles.join(", ")}`);
  if (k.tone.description) parts.push(k.tone.description);
  if (k.tone.phrases.length) parts.push(`Signature phrases (use naturally, not in every message):\n${bullets(k.tone.phrases)}`);
  if (k.tone.emojis) parts.push(`Emoji usage: ${k.tone.emojis}`);

  parts.push(`\n## Training philosophy and principles\n${k.philosophy}`);

  parts.push(`\n## Nutrition approach: ${NUTRITION_LABELS[k.nutrition.approach]}`);
  parts.push(
    k.nutrition.showNumbersToClients
      ? "The coach is fine with showing calorie and macro numbers to clients."
      : "Do NOT show calorie or macro numbers to clients. Plans still carry an internal calorie estimate for the safety check.",
  );
  parts.push(k.nutrition.details);

  parts.push(`\n## Training\n${k.training.principles}`);
  if (k.training.preferredExercises.length) {
    parts.push(`Preferred exercises:\n${bullets(k.training.preferredExercises)}`);
  }
  if (k.training.avoidedExercises.length) {
    parts.push(
      `Exercises this coach avoids (never program them; use the alternative):\n${bullets(
        k.training.avoidedExercises.map(
          (e) => `${e.name}${e.reason ? ` (why: ${e.reason})` : ""}${e.alternative ? ` → use instead: ${e.alternative}` : ""}`,
        ),
      )}`,
    );
  }
  for (const p of k.training.samplePrograms) {
    parts.push(`\n### Sample program: ${p.name}\n${p.description}`);
  }

  if (k.injuries.length) {
    parts.push("\n## Injury guidelines (the coach's rules; never diagnose)");
    for (const inj of k.injuries) {
      parts.push(`### ${inj.area}\n${inj.guidance}`);
      if (inj.allowed.length) parts.push(`Allowed:\n${bullets(inj.allowed)}`);
      if (inj.forbidden.length) parts.push(`Forbidden:\n${bullets(inj.forbidden)}`);
    }
  }

  parts.push("\n## Supplements");
  parts.push(
    k.supplements.allowed.length
      ? `The only supplements this coach approves:\n${bullets(k.supplements.allowed)}`
      : "This coach approves no supplements.",
  );
  if (k.supplements.policy) parts.push(k.supplements.policy);

  if (k.faq.length) {
    parts.push("\n## FAQ (answer in the coach's words)");
    for (const f of k.faq) parts.push(`Q: ${f.q}\nA: ${f.a}`);
  }

  if (k.alwaysEscalate.length) {
    parts.push(
      `\n## Always pass to the coach (do not answer yourself; say you'll check with the coach and call escalate_to_coach)\n${bullets(k.alwaysEscalate)}`,
    );
  }

  if (inlineDocs.length) {
    parts.push("\n## Coach documents");
    for (const d of inlineDocs) parts.push(`<document title="${d.title}">\n${d.text}\n</document>`);
  }
  parts.push("</coach_knowledge>");
  return parts.join("\n");
}
