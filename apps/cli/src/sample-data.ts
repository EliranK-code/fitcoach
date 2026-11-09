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
      name: "Dana Cohen",
      age: 32,
      sex: "female",
      heightCm: 165,
      weightKg: 66.8,
      goal: "fat_loss",
      goalDetails: "Lose 5 kg before her sister's wedding in June",
      experience: "intermediate",
      trainingDaysPerWeek: 3,
      sessionMinutes: 60,
      equipment: "gym",
      injuries: ["Slight sensitivity in the right knee"],
      medicalConditions: [],
      medications: [],
      dietaryPreferences: ["Eats everything", "Doesn't like fish"],
      allergies: [],
      notes: [{ date: day(-10), text: "Trains best in the morning, before work" }],
    },
    weights: [69.2, 68.9, 68.7, 68.1, 68.3, 67.8, 67.5, 67.4, 67.0, 66.8],
    chat: [
      ["client", "Good morning! Weighed in at 66.8 today 🎉"],
      ["bot", "Let's go Dana!! 2.4 kg since the start, at exactly a healthy pace 💪 Consistency beats perfection. How did the knee feel in yesterday's workout?"],
      ["client", "The knee was fine, I did box squats like you said"],
      ["bot", "Great, that's exactly the exercise. Let's stay on it one more week and then try a deeper range 👏"],
      ["client", "How much is it to add a personal session with Alex once a month?"],
      ["bot", "Good question! I'm checking it with Alex and will get back to you 🙏"],
    ],
    alerts: [
      {
        type: "unknown_question",
        severity: "low",
        source: "model",
        summary: "Dana is asking about the price of a monthly personal session. The topic is on the 'always pass to the coach' list.",
        question: "How much is it to add a personal session with Alex once a month?",
      },
    ],
    memory: "• Goal: lose 5 kg by June (her sister's wedding)\n• Progressing well: from 69.2 to 66.8 in a month\n• Sensitive right knee: working with box squats\n• Prefers morning workouts",
  },
  {
    id: `${PREFIX}yossi`,
    profile: {
      name: "Josh Levy",
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
      medicalConditions: ["High blood pressure"],
      medications: ["Blood pressure medication"],
      dietaryPreferences: ["Eats everything"],
      allergies: ["Nuts"],
    },
    weights: [93.5, 93.1, 92.6, 92.0],
    chat: [
      ["client", "In yesterday's workout I felt chest pressure and a bit of dizziness, is that normal?"],
      [
        "bot",
        "Josh, thanks for telling me. Chest pressure and dizziness aren't something to keep training through: stop training until a doctor checks you, and if it comes back now call emergency services right away. I've also let Alex know 🙏",
      ],
    ],
    alerts: [
      { type: "medical", severity: "urgent", source: "detector", summary: "Detected in the client's message: chest pressure and dizziness during a workout.", question: null },
    ],
    paused: true,
  },
  {
    id: `${PREFIX}noa`,
    profile: { name: "Noa", age: 16, sex: "female", goal: "strength", experience: "beginner" },
    weights: [],
    chat: [
      ["client", "Hi, I'm 16 and I want to start training at home"],
      ["bot", "So cool that you want to start! 😊 To build you something safe, we'd like to do it together with a parent. Tell me, how many days a week work for you?"],
    ],
    alerts: [{ type: "minor", severity: "medium", source: "detector", summary: "The client is 16 (a minor).", question: null }],
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
      await addMeal(db, t, client.id, { eatenOn: day(0), mealType: "breakfast", description: "Shakshuka with 2 eggs, a slice of whole-grain bread and salad", estCalories: null, estProteinG: null });
      await addWorkout(db, t, client.id, {
        performedOn: day(-1),
        title: "Workout A",
        durationMin: 55,
        exercises: [
          { name: "Box squat", sets: 3, reps: 10, weightKg: 20 },
          { name: "Dumbbell bench press", sets: 3, reps: 9, weightKg: 10 },
          { name: "One-arm dumbbell row", sets: 3, reps: 12, weightKg: 12 },
        ],
        notes: "The knee felt good",
      });
      await saveMealPlan(db, t, client.id, {
        planText: "*Breakfast*\n• 2 eggs\n• A slice of whole-grain bread\n• Cut vegetables\n\n*Lunch*\n• A palm of chicken or turkey\n• A cupped hand of rice\n• Half a plate of salad\n\n*Dinner*\n• Cottage cheese or tuna\n• Vegetables\n• Half a carb portion",
        dailyCalories: 1650,
        proteinG: 110,
        showNumbers: false,
      });
      await saveWorkoutPlan(db, t, client.id, {
        planText: "*Workout A*\n• Box squat 3×8-10\n• Bench press 3×8-10\n• Row 3×10-12\n• Glute bridge 3×12\n\n*Workout B*\n• Romanian deadlift 3×8-10\n• Shoulder press 3×8-10\n• Lat pulldown 3×10-12\n• Dead bug 3×8",
        days: [
          { label: "A", exercises: [{ name: "Box squat", sets: 3, reps: "8-10", targetWeightKg: 20, notes: "" }] },
          { label: "B", exercises: [{ name: "Romanian deadlift", sets: 3, reps: "8-10", targetWeightKg: 24, notes: "" }] },
        ],
        progressionRule: "Double progression: reach the top of the range on every set, then add weight",
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
