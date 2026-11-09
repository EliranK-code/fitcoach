import { describe, expect, it } from "vitest";
import { isConsentAccept, isConsentDecline, isDeletionConfirmation, isDeletionRequest } from "../src/consent";
import {
  decryptText,
  encryptText,
  newDataKey,
  normalizePhone,
  phoneHash,
  unwrapDataKey,
  wrapDataKey,
} from "../src/crypto";
import { splitForWhatsApp, toWhatsAppFormat } from "../src/format/whatsapp";
import { chunkText } from "../src/knowledge/chunker";
import { sanitizeAssistantContent } from "../src/llm/client";
import { applyProfileUpdate, missingOnboardingFields, ProfileValueError } from "../src/profile";
import { calorieFloor, estimateTdee } from "../src/safety/calories";
import { containsNutritionNumbers } from "../src/safety/outputGuards";
import { detectRedFlags } from "../src/safety/redFlags";
import { isValidTimeZone, localDate, localStamp, timeZoneOptions } from "../src/time";
import { loadConfig } from "../src/config";

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
    expect(normalizePhone("+972 50 123 4567")).toBe("972501234567");
    expect(normalizePhone("00972501234567")).toBe("972501234567");
    expect(normalizePhone("+1 (415) 555-0123")).toBe("14155550123");
    expect(normalizePhone("CLI-Demo-1")).toBe("cli-demo-1");
    expect(phoneHash("a", "+972 50-123-4567")).toBe(phoneHash("a", "00972501234567"));
    expect(phoneHash("a", "+972501234567")).not.toBe(phoneHash("b", "+972501234567"));
  });

  it("gives a local number (one leading 0) the configured country code, and no country by default", () => {
    expect(normalizePhone("050-123-4567", "972")).toBe("972501234567");
    expect(normalizePhone("07700 900123", "44")).toBe("447700900123");
    expect(normalizePhone("0044 7700 900123", "972")).toBe("447700900123"); // 00 is the international prefix, not local
    expect(normalizePhone("+1 415 555 0123", "972")).toBe("14155550123");
    // No code: the number stays as typed, so it can't match a WhatsApp number by accident.
    expect(normalizePhone("050-123-4567", "")).toBe("0501234567");
    // Without an argument the code comes from DEFAULT_COUNTRY_CODE, which the test environment leaves empty.
    expect(normalizePhone("050-123-4567")).toBe("0501234567");
    expect(phoneHash("a", "050-123-4567")).not.toBe(phoneHash("a", "972501234567"));
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

  it("understands the English replies the consent notice asks for", () => {
    expect(isConsentAccept("I agree")).toBe(true);
    expect(isConsentAccept("I agree ✅")).toBe(true);
    expect(isConsentDecline("I don't agree")).toBe(true);
    expect(isConsentDecline("I don't agree.")).toBe(true);
    expect(isConsentAccept("I don't agree")).toBe(false);
    expect(isDeletionConfirmation("Delete permanently")).toBe(true);
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

  it("validates time zones and lists them all, UTC first", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(`Europe/${"x".repeat(80)}`)).toBe(false);

    const zones = timeZoneOptions("Etc/GMT-3", "Not/AZone");
    expect(zones[0]).toBe("UTC");
    expect(zones.length).toBeGreaterThan(300);
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toEqual(expect.arrayContaining(["Asia/Jerusalem", "Australia/Sydney", "America/Sao_Paulo", "Asia/Kolkata", "Etc/GMT-3"]));
    expect(zones).not.toContain("Not/AZone");
    // Current IANA names, not the old ones ICU still lists.
    expect(zones).toEqual(expect.arrayContaining(["Europe/Kyiv", "Asia/Kathmandu", "Asia/Ho_Chi_Minh"]));
    expect(zones).not.toContain("Asia/Calcutta");
    expect(zones).not.toContain("Europe/Kiev");
    // A coach who saved an old name still sees it selected.
    expect(timeZoneOptions("Asia/Calcutta")).toContain("Asia/Calcutta");
    expect(zones.slice(1)).toEqual([...zones.slice(1)].sort());
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

describe("config defaults for other countries", () => {
  it("defaults TIMEZONE to UTC and rejects a zone that doesn't exist", () => {
    expect(loadConfig({ TIMEZONE: "" }).TIMEZONE).toBe("UTC");
    expect(loadConfig({ TIMEZONE: "Europe/Lisbon" }).TIMEZONE).toBe("Europe/Lisbon");
    expect(() => loadConfig({ TIMEZONE: "Middle/Earth" })).toThrow(/TIMEZONE/);
  });

  it("reads DEFAULT_COUNTRY_CODE with or without the plus, and rejects anything else", () => {
    expect(loadConfig({ DEFAULT_COUNTRY_CODE: "" }).DEFAULT_COUNTRY_CODE).toBeUndefined();
    expect(loadConfig({ DEFAULT_COUNTRY_CODE: "+" }).DEFAULT_COUNTRY_CODE).toBeUndefined();
    expect(loadConfig({ DEFAULT_COUNTRY_CODE: "+44" }).DEFAULT_COUNTRY_CODE).toBe("44");
    expect(loadConfig({ DEFAULT_COUNTRY_CODE: " 972 " }).DEFAULT_COUNTRY_CODE).toBe("972");
    for (const bad of ["0972", "1234", "UK"]) expect(() => loadConfig({ DEFAULT_COUNTRY_CODE: bad })).toThrow(/DEFAULT_COUNTRY_CODE/);
  });
});
