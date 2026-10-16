import {
  addMeal,
  addWeight,
  addWorkout,
  createAlert,
  deleteClientData,
  findOrCreateClient,
  listClients,
  clientPhone,
  logChatMessage,
  saveMealPlan,
  saveMemory,
  saveProfile,
  saveWorkoutPlan,
  setClientFlags,
  updateClient,
  type AlertInput,
  type ClientProfile,
  type Db,
  type TenantContext,
} from "@fitcoach/core";

// Demo data for exploring the dashboard without real clients or an API key. Every sample client's id
// starts with "sample-", so --remove can find and delete exactly these.

const PREFIX = "sample-";

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

interface Sample {
  id: string;
  profile: ClientProfile;
  weights: number[];
  chat: [sender: "client" | "bot", text: string][];
  alerts?: Omit<AlertInput, "clientId">[];
  memory?: string;
  flags?: { minor?: boolean; eatingDisorderRisk?: boolean };
  paused?: boolean;
}

const SAMPLES: Sample[] = [
  {
    id: `${PREFIX}dana`,
    profile: {
      name: "דנה כהן",
      age: 32,
      sex: "female",
      heightCm: 165,
      weightKg: 66.8,
      goal: "fat_loss",
      goalDetails: "לרדת 5 ק\"ג לפני החתונה של אחותה ביוני",
      experience: "intermediate",
      trainingDaysPerWeek: 3,
      sessionMinutes: 60,
      equipment: "gym",
      injuries: ["רגישות קלה בברך ימין"],
      medicalConditions: [],
      medications: [],
      dietaryPreferences: ["אוכלת הכל", "לא אוהבת דגים"],
      allergies: [],
      notes: [{ date: day(-10), text: "מתאמנת הכי טוב בבוקר, לפני העבודה" }],
    },
    weights: [69.2, 68.9, 68.7, 68.1, 68.3, 67.8, 67.5, 67.4, 67.0, 66.8],
    chat: [
      ["client", "בוקר טוב! שקלתי היום 66.8 🎉"],
      ["bot", "יאללה דנה!! 2.4 ק\"ג מתחילת הדרך, ובקצב בריא בדיוק 💪 עקביות מנצחת שלמות. איך הרגישה הברך באימון אתמול?"],
      ["client", "הברך בסדר, עשיתי סקוואט לתיבה כמו שאמרת"],
      ["bot", "מעולה, זה בדיוק התרגיל. נשאר עליו עוד שבוע ואז נבדוק טווח עמוק יותר 👏"],
      ["client", "כמה עולה להוסיף אימון אישי עם גל פעם בחודש?"],
      ["bot", "שאלה טובה! אני בודק את זה עם גל וחוזר אלייך 🙏"],
    ],
    alerts: [
      {
        type: "unknown_question",
        severity: "low",
        source: "model",
        summary: "דנה שואלת על מחיר של אימון אישי חודשי. הנושא ברשימת 'תמיד להעביר למאמן'.",
        question: "כמה עולה להוסיף אימון אישי עם גל פעם בחודש?",
      },
    ],
    memory: "• מטרה: ירידה של 5 ק\"ג עד יוני (חתונה של אחותה)\n• מתקדמת יפה: מ-69.2 ל-66.8 בחודש\n• ברך ימין רגישה: עובדים עם סקוואט לתיבה\n• מעדיפה אימוני בוקר",
  },
  {
    id: `${PREFIX}yossi`,
    profile: {
      name: "יוסי לוי",
      age: 45,
      sex: "male",
      heightCm: 178,
      weightKg: 92,
      goal: "health",
      experience: "beginner",
      trainingDaysPerWeek: 2,
      sessionMinutes: 45,
      equipment: "home",
      injuries: [],
      medicalConditions: ["לחץ דם גבוה"],
      medications: ["תרופה ללחץ דם"],
      dietaryPreferences: ["אוכל הכל"],
      allergies: ["אגוזים"],
    },
    weights: [93.5, 93.1, 92.6, 92.0],
    chat: [
      ["client", "באימון אתמול הרגשתי לחץ בחזה וקצת סחרחורת, זה נורמלי?"],
      [
        "bot",
        "יוסי, תודה שסיפרת. לחץ בחזה וסחרחורת זה לא משהו שממשיכים איתו: עצור את האימונים עד שרופא יבדוק אותך, ואם זה חוזר עכשיו פנה מיד למד\"א 101. עדכנתי גם את גל 🙏",
      ],
    ],
    alerts: [
      { type: "medical", severity: "urgent", source: "detector", summary: "זוהה בהודעת הלקוח: לחץ בחזה וסחרחורת באימון.", question: null },
    ],
    paused: true,
  },
  {
    id: `${PREFIX}noa`,
    profile: { name: "נועה", age: 16, sex: "female", goal: "strength", experience: "beginner" },
    weights: [],
    chat: [
      ["client", "היי, אני בת 16 ורוצה להתחיל להתאמן בבית"],
      ["bot", "איזה כיף שאת רוצה להתחיל! 😊 כדי לבנות לך משהו בטוח, נשמח לעשות את זה ביחד עם הורה. ספרי לי, כמה ימים בשבוע נוח לך?"],
    ],
    alerts: [{ type: "minor", severity: "medium", source: "detector", summary: "הלקוחה בת 16 (קטינה).", question: null }],
    flags: { minor: true },
  },
];

export async function createSampleData(db: Db, t: TenantContext): Promise<number> {
  for (const s of SAMPLES) {
    const { client } = await findOrCreateClient(db, t, { phone: s.id, channel: "cli" });
    await updateClient(db, t, client.id, {
      consentStatus: "granted",
      consentAt: new Date(Date.now() - 30 * 24 * 3600_000),
      consentVersion: "sample",
      lastInboundAt: new Date(Date.now() - Math.floor(Math.random() * 6) * 3600_000),
      botPaused: Boolean(s.paused),
    });
    if (s.flags) await setClientFlags(db, t, client, s.flags);
    await saveProfile(db, t, client.id, s.profile);
    for (const [i, w] of s.weights.entries()) await addWeight(db, t, client.id, w, day(-3 * (s.weights.length - 1 - i)));
    for (const [sender, text] of s.chat) {
      await logChatMessage(db, t, { clientId: client.id, direction: sender === "client" ? "in" : "out", sender, body: text, status: sender === "bot" ? "read" : undefined });
    }
    for (const a of s.alerts ?? []) await createAlert(db, t, { ...a, clientId: client.id });
    if (s.memory) await saveMemory(db, t, client.id, s.memory, null);
    if (s.profile.goal === "fat_loss") {
      await addMeal(db, t, client.id, { eatenOn: day(0), mealType: "breakfast", description: "שקשוקה עם 2 ביצים, פרוסת לחם מלא וסלט", estCalories: null, estProteinG: null });
      await addWorkout(db, t, client.id, {
        performedOn: day(-1),
        title: "אימון A",
        durationMin: 55,
        exercises: [
          { name: "סקוואט לתיבה", sets: 3, reps: 10, weightKg: 20 },
          { name: "לחיצת חזה עם משקולות יד", sets: 3, reps: 9, weightKg: 10 },
          { name: "חתירה עם משקולת יד", sets: 3, reps: 12, weightKg: 12 },
        ],
        notes: "הברך הרגישה טוב",
      });
      await saveMealPlan(db, t, client.id, {
        planText: "*ארוחת בוקר*\n• 2 ביצים\n• פרוסת לחם מלא\n• ירקות חתוכים\n\n*צהריים*\n• כף יד עוף או הודו\n• כף יד קעורה אורז\n• חצי צלחת סלט\n\n*ערב*\n• קוטג' או טונה\n• ירקות\n• חצי מנת פחמימה",
        dailyCalories: 1650,
        proteinG: 110,
        showNumbers: false,
      });
      await saveWorkoutPlan(db, t, client.id, {
        planText: "*אימון A*\n• סקוואט לתיבה 3×8-10\n• לחיצת חזה 3×8-10\n• חתירה 3×10-12\n• גשר עכוז 3×12\n\n*אימון B*\n• דדליפט רומני 3×8-10\n• לחיצת כתפיים 3×8-10\n• פולי עליון 3×10-12\n• דד באג 3×8",
        days: [
          { label: "A", exercises: [{ name: "סקוואט לתיבה", sets: 3, reps: "8-10", targetWeightKg: 20, notes: "" }] },
          { label: "B", exercises: [{ name: "דדליפט רומני", sets: 3, reps: "8-10", targetWeightKg: 24, notes: "" }] },
        ],
        progressionRule: "התקדמות כפולה: מגיעים לקצה העליון של הטווח בכל הסטים ומוסיפים משקל",
      });
    }
  }
  return SAMPLES.length;
}

export async function removeSampleData(db: Db, t: TenantContext): Promise<number> {
  let n = 0;
  for (const c of await listClients(db, t)) {
    if (clientPhone(t, c).startsWith(PREFIX)) {
      await deleteClientData(db, t, c.id, "cli");
      n++;
    }
  }
  return n;
}
