import { describe, expect, it } from "vitest";
import { isConsentAccept, isConsentDecline, isDeletionConfirmation, isDeletionRequest } from "../src/consent.js";
import {
  decryptText,
  encryptText,
  newDataKey,
  normalizePhone,
  phoneHash,
  unwrapDataKey,
  wrapDataKey,
} from "../src/crypto.js";
import { splitForWhatsApp, toWhatsAppFormat } from "../src/format/whatsapp.js";
import { chunkText } from "../src/knowledge/chunker.js";
import { sanitizeAssistantContent } from "../src/llm/client.js";
import { applyProfileUpdate, missingOnboardingFields, ProfileValueError } from "../src/profile.js";
import { calorieFloor, estimateTdee } from "../src/safety/calories.js";
import { containsNutritionNumbers } from "../src/safety/outputGuards.js";
import { detectRedFlags } from "../src/safety/redFlags.js";
import { localDate, localStamp } from "../src/time.js";

describe("crypto", () => {
  it("round-trips text and binds ciphertext to its coach", () => {
    const a = { coachId: "coach-a", dek: newDataKey() };
    const sealed = encryptText(a, "כאב בברך שמאל");
    expect(sealed.startsWith("e1.")).toBe(true);
    expect(decryptText(a, sealed)).toBe("כאב בברך שמאל");
    // Same key, different coach id: the associated data no longer matches.
    expect(() => decryptText({ coachId: "coach-b", dek: a.dek }, sealed)).toThrow();
    // Different key entirely.
    expect(() => decryptText({ coachId: "coach-a", dek: newDataKey() }, sealed)).toThrow();
  });

  it("wraps data keys with the master key per coach", () => {
    const dek = newDataKey();
    const wrapped = wrapDataKey(dek, "coach-a");
    expect(unwrapDataKey(wrapped, "coach-a").equals(dek)).toBe(true);
    expect(() => unwrapDataKey(wrapped, "coach-b")).toThrow();
  });

  it("normalizes phones and hashes them per coach", () => {
    expect(normalizePhone("050-123-4567")).toBe("972501234567");
    expect(normalizePhone("+972 50 123 4567")).toBe("972501234567");
    expect(normalizePhone("00972501234567")).toBe("972501234567");
    expect(normalizePhone("CLI-Demo-1")).toBe("cli-demo-1");
    expect(phoneHash("a", "0501234567")).toBe(phoneHash("a", "+972501234567"));
    expect(phoneHash("a", "0501234567")).not.toBe(phoneHash("b", "0501234567"));
  });
});

describe("profile updates", () => {
  const today = "2026-10-16";

  it("parses typed values from strings", () => {
    let p = applyProfileUpdate({}, "age", "34", today);
    p = applyProfileUpdate(p, "weightKg", "82,5 קילו", today);
    p = applyProfileUpdate(p, "sex", "female", today);
    p = applyProfileUpdate(p, "injuries", "כאב בברך שמאל; רגישות בכתף", today);
    p = applyProfileUpdate(p, "allergies", "אין", today);
    p = applyProfileUpdate(p, "notes", "לא אוהבת לרוץ", today);
    expect(p).toMatchObject({
      age: 34,
      weightKg: 82.5,
      sex: "female",
      injuries: ["כאב בברך שמאל", "רגישות בכתף"],
      allergies: [],
      notes: [{ date: today, text: "לא אוהבת לרוץ" }],
    });
  });

  it("rejects invalid values", () => {
    expect(() => applyProfileUpdate({}, "age", "250", today)).toThrow(ProfileValueError);
    expect(() => applyProfileUpdate({}, "goal", "be_huge", today)).toThrow(ProfileValueError);
    expect(() => applyProfileUpdate({}, "favoriteColor", "blue", today)).toThrow(ProfileValueError);
  });

  it("tracks which onboarding fields are still missing", () => {
    const missing = missingOnboardingFields({ name: "דנה", age: 30, injuries: [] }).map((f) => f.key);
    expect(missing).toContain("weightKg");
    expect(missing).not.toContain("injuries");
    expect(missing).not.toContain("name");
  });
});

describe("red-flag detector", () => {
  const categories = (text: string) => detectRedFlags(text).map((h) => h.category);

  it.each([
    ["יש לי כאב בחזה כשאני רץ", "cardiac"],
    ["התעלפתי באמצע האימון", "cardiac"],
    ["I get chest pain when I run", "cardiac"],
    ["הרגשתי סחרחורת אחרי הסקוואט", "dizziness"],
    ["נקעתי את הקרסול אתמול", "injury"],
    ["אני בהריון, חודש רביעי", "pregnancy"],
    ["יש לי סוכרת סוג 2", "medical_condition"],
    ["אחרי ארוחות גדולות אני מקיאה אחרי", "eating_disorder"],
    ["אני אוכלת רק 600 קלוריות ביום", "eating_disorder"],
    ["מה דעתך על סטרואידים?", "substances"],
    ["should I try SARMs?", "substances"],
    ["לפעמים אני לא רוצה לחיות", "self_harm"],
    ["אני בן 16 ורוצה להתחיל להתאמן", "minor"],
    ["I'm 15", "minor"],
  ])("flags %s", (text, category) => {
    expect(categories(text)).toContain(category);
  });

  it.each([
    "קרעתי את האימון היום!",
    "שברתי שיא בסקוואט 🔥",
    "I'm starving after leg day",
    "I'm 15 minutes late to the gym",
    "אני צם 16 שעות בשיטת צום לסירוגין",
    "אני בן 34, שוקל 85",
    "אכלתי פיצה אתמול, מרגיש אשם קצת",
  ])("does not flag %s", (text) => {
    expect(detectRedFlags(text)).toEqual([]);
  });
});

describe("calorie floor", () => {
  const base = { age: 30, heightCm: 165, weightKg: 70, trainingDaysPerWeek: 3 };

  it("uses the higher of the absolute minimum and a 25% deficit", () => {
    const tdee = estimateTdee({ ...base, sex: "female" })!;
    const floor = calorieFloor({ ...base, sex: "female" }, {}, { minor: false });
    expect(floor.floor).toBe(Math.max(1200, Math.round(tdee * 0.75)));
  });

  it("never goes below the platform minimum, even if a coach configures lower", () => {
    const small = { age: 70, heightCm: 150, weightKg: 45, sex: "female" as const };
    expect(calorieFloor(small, { calorieFloorFemale: 900 }, { minor: false }).floor).toBeGreaterThanOrEqual(1200);
  });

  it("lets a coach raise the floor", () => {
    const small = { age: 70, heightCm: 150, weightKg: 45, sex: "female" as const };
    expect(calorieFloor(small, { calorieFloorFemale: 1400 }, { minor: false }).floor).toBeGreaterThanOrEqual(1400);
  });

  it("allows no deficit for minors", () => {
    const teen = { age: 16, heightCm: 175, weightKg: 65, sex: "male" as const, trainingDaysPerWeek: 3 };
    const floor = calorieFloor(teen, {}, { minor: true });
    expect(floor.floor).toBeGreaterThanOrEqual(estimateTdee(teen)!);
  });

  it("falls back to the absolute minimum when the profile is incomplete", () => {
    expect(calorieFloor({}, {}, { minor: false }).floor).toBe(1500);
  });
});

describe("output guards", () => {
  it.each(["תכוון ל-1500 קלוריות ביום", "1,800 קק\"ל", "kcal: 2000", "120 גרם חלבון", "protein 140g"])(
    "detects nutrition numbers in %s",
    (t) => expect(containsNutritionNumbers(t)).toBe(true),
  );
  it.each(["כף יד של חלבון בכל ארוחה", "3 סטים של 10 חזרות", "שתי כוסות מים"])("allows %s", (t) =>
    expect(containsNutritionNumbers(t)).toBe(false),
  );
});

describe("WhatsApp formatting", () => {
  it("converts Markdown to WhatsApp syntax", () => {
    expect(toWhatsAppFormat("## ארוחת בוקר\n- **ביצים** 2\n- לחם")).toBe("*ארוחת בוקר*\n• *ביצים* 2\n• לחם");
  });

  it("splits long text on paragraph boundaries under the limit", () => {
    const para = "א".repeat(600);
    const parts = splitForWhatsApp([para, para, para].join("\n\n"), 1500);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1500);
    expect(parts.join("\n\n")).toBe([para, para, para].join("\n\n"));
  });

  it("hard-splits a single oversized line", () => {
    const parts = splitForWhatsApp("מילה ".repeat(800).trim(), 1500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1500);
  });
});

describe("consent and deletion intents", () => {
  it("recognizes accept / decline", () => {
    expect(isConsentAccept("מאשרת!")).toBe(true);
    expect(isConsentAccept("", "consent_yes")).toBe(true);
    expect(isConsentAccept("מה זה?")).toBe(false);
    expect(isConsentDecline("לא מאשר")).toBe(true);
  });

  it("recognizes deletion requests and confirmation", () => {
    expect(isDeletionRequest("תמחקו בבקשה, מחק את המידע שלי")).toBe(true);
    expect(isDeletionRequest("please delete my data")).toBe(true);
    expect(isDeletionRequest("מחקתי את האפליקציה")).toBe(false);
    expect(isDeletionConfirmation("מחק לצמיתות")).toBe(true);
  });
});

describe("misc", () => {
  it("chunks text with overlap and respects the budget", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `פסקה ${i} `.repeat(40));
    const chunks = chunkText(paras.join("\n\n"), 300, 40);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300 * 3 + 40 * 3 + 2000);
  });

  it("formats local time in the client's zone", () => {
    const d = new Date("2026-10-16T21:30:00Z"); // 00:30 next day in Israel (IDT, UTC+3)
    expect(localDate(d, "Asia/Jerusalem")).toBe("2026-10-17");
    expect(localStamp(d, "Asia/Jerusalem")).toBe("2026-10-17 00:30 Sat");
  });

  it("drops the declined model's thinking and tool calls before a fallback boundary", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "partial", citations: null },
      { type: "tool_use", id: "t1", name: "x", input: {} },
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      { type: "thinking", thinking: "", signature: "s2" },
      { type: "text", text: "final", citations: null },
    ] as never;
    expect(sanitizeAssistantContent(content).map((b) => b.type)).toEqual(["text", "thinking", "text"]);
  });
});
