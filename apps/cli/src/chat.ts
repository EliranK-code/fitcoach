import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import {
  audit,
  describeProfile,
  exportClientData,
  logChatMessage,
  updateClient,
  findClientByPhone,
  getActiveMealPlan,
  getActiveWorkoutPlan,
  getMemory,
  getProfile,
  listAlerts,
  listMeals,
  listWeights,
  listWorkouts,
  localStamp,
  type TenantContext,
  type TurnEvent,
  type TurnResult,
} from "@fitcoach/core";
import { renderForTerminal } from "./bidi.js";
import type { App } from "./bootstrap.js";

type Color = Parameters<typeof styleText>[0];

const HELP = `פקודות:
/profile   הפרופיל שהבוט אסף
/logs      שקילות, ארוחות ואימונים (30 ימים)
/plans     התפריט ותוכנית האימונים הנוכחיים
/alerts    ההתראות שנפתחו למאמן על הלקוח הזה
/summary   הזיכרון ארוך הטווח (סיכום השיחות)
/compact   לסכם עכשיו ולפתוח אפיזודה חדשה
/export    לייצא את כל המידע של הלקוח לקובץ JSON
/delete-me לבקש מחיקת מידע (כמו לקוח אמיתי)
/debug     להציג או להסתיר קריאות לכלים ושימוש בטוקנים
/new       להתחיל כלקוח חדש
/help      העזרה הזאת
/quit      יציאה

בתפקיד המאמן (השתלטות על השיחה):
/pause         להשהות את הבוט ללקוח הזה
/coach <טקסט>  לכתוב ללקוח הודעה בשם המאמן
/resume        להחזיר את הבוט (הוא יקבל את מה שנאמר בזמן ההשהיה)`;

const SEVERITY_HE: Record<string, string> = { low: "נמוכה", medium: "בינונית", high: "גבוהה", urgent: "דחופה" };

export interface ChatOptions {
  coach: string;
  phone: string;
  debug: boolean;
  bidi: boolean;
}

export async function runChat(app: App, opts: ChatOptions): Promise<void> {
  const t = await app.tenant(opts.coach);
  let phone = opts.phone;
  let debug = opts.debug;
  const tty = Boolean(process.stdout.isTTY);
  // Cursor tricks (erase the echoed line, the "…" indicator) only make sense on a real terminal.
  const eraseLine = () => {
    if (tty) process.stdout.write("\x1b[1A\x1b[2K");
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.setPrompt(styleText("cyan", "> "));

  const transcriptDir = join(".data", "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  let transcriptPath = "";
  const startTranscript = () => {
    transcriptPath = join(transcriptDir, `${opts.coach}-${phone}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    writeFileSync(transcriptPath, `# שיחה עם הבוט של ${t.coachName} (לקוח: ${phone})\n\n`);
  };
  const toTranscript = (who: string, text: string) =>
    appendFileSync(transcriptPath, `**${who}** (${localStamp(new Date(), app.cfg.TIMEZONE)}):\n\n${text}\n\n---\n\n`);

  const print = (text: string, color?: Color, indent = 0) => {
    const rendered = renderForTerminal(text, { bidi: opts.bidi, indent });
    console.log(color ? styleText(color, rendered) : rendered);
  };

  startTranscript();
  print(`צ'אט עם הבוט של ${t.coachName}. את/ה בתפקיד לקוח/ה (מזהה: ${phone}).`, "bold");
  print("כתבו /help לרשימת הפקודות. ה-transcript נשמר ב:", "gray");
  console.log(styleText("gray", transcriptPath));
  console.log();

  // Async iteration buffers lines that arrive while a turn is still running (fast typing, piped scripts).
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    // The terminal echoed the typed Hebrew in memory order; redraw it in visual order.
    if (opts.bidi && process.stdin.isTTY) eraseLine();

    if (line.startsWith("/")) {
      const cmd = line.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
      if (cmd === "quit" || cmd === "exit") break;
      try {
        const result = await runCommand(app, t, phone, cmd, line.slice(cmd.length + 1).trim(), { print, debug });
        if (result === "toggle-debug") {
          debug = !debug;
          print(debug ? "מצב debug פעיל" : "מצב debug כבוי", "gray");
        } else if (result === "new-client") {
          phone = `cli-${Math.random().toString(36).slice(2, 8)}`;
          startTranscript();
          print(`לקוח/ה חדש/ה: ${phone}`, "bold");
        } else if (result === "delete-me") {
          await send("מחק את המידע שלי");
        }
      } catch (err) {
        print(`שגיאה: ${err instanceof Error ? err.message : String(err)}`, "red");
      }
      rl.prompt();
      continue;
    }

    await send(line);
    rl.prompt();
  }

  rl.close();

  async function send(text: string) {
    print(`את/ה: ${text}`, "cyan");
    toTranscript("לקוח/ה", text);
    if (tty) process.stdout.write(styleText("gray", "…\n"));
    let res: TurnResult;
    try {
      res = await app.engine.handleInbound({ coachId: t.coachId, phone, text, channel: "cli", isTest: true });
    } catch (err) {
      eraseLine();
      print(`שגיאה: ${err instanceof Error ? err.message : String(err)}`, "red");
      return;
    }
    eraseLine();
    printEvents(res.events, debug, print);
    if (res.replies.length === 0) print("(הבוט לא ענה: השיחה מושהית למאמן)", "gray");
    for (const reply of res.replies) {
      console.log(styleText("green", renderForTerminal(`🤖 ${t.coachName} (בוט):`, { bidi: opts.bidi })));
      print(reply);
      toTranscript("בוט", reply);
      console.log();
    }
    if (res.buttons?.length) print(`כפתורים: ${res.buttons.map((b) => `[${b.title}]`).join("  ")}`, "gray");
    if (res.error) print(`פרטי השגיאה (רק למפתחים): ${res.error}`, "red");
  }
}

function printEvents(events: TurnEvent[], debug: boolean, print: (text: string, color?: Color) => void) {
  for (const e of events) {
    if (e.type === "alert" && !e.deduped) {
      print(`⚠️  התראה למאמן: ${e.alertType} (חומרה ${SEVERITY_HE[e.severity] ?? e.severity}, מקור: ${e.source}) ${e.summary}`, "yellow");
    }
    if (!debug) continue;
    if (e.type === "tool") {
      const input = JSON.stringify(e.input);
      print(`🔧 ${e.name}${e.ok ? "" : " ✗"}: ${input.length > 300 ? `${input.slice(0, 300)}…` : input}`, "gray");
      print(`   ↳ ${e.result.length > 300 ? `${e.result.slice(0, 300)}…` : e.result}`, "gray");
    } else if (e.type === "epoch") {
      print(`🧠 אפיזודה ${e.action === "created" ? "חדשה" : "חדשה אחרי סיכום"} (${e.reason})`, "gray");
    } else if (e.type === "usage") {
      print(`📊 ${e.model}: input ${e.input}, cache read ${e.cacheRead}, cache write ${e.cacheWrite}, output ${e.output}`, "gray");
    } else if (e.type === "guard") {
      print(`🛡️  ${e.detail}`, "gray");
    } else if (e.type === "refusal") {
      print(`🚫 סירוב של מודל ה-AI (קטגוריה: ${e.category ?? "לא ידוע"})`, "gray");
    }
  }
}

async function runCommand(
  app: App,
  t: TenantContext,
  phone: string,
  cmd: string,
  arg: string,
  ui: { print: (text: string, color?: Color) => void; debug: boolean },
): Promise<"toggle-debug" | "new-client" | "delete-me" | void> {
  const { db } = app.handle;
  const { print } = ui;
  if (cmd === "help") return print(HELP, "gray");
  if (cmd === "debug") return "toggle-debug";
  if (cmd === "new") return "new-client";
  if (cmd === "delete-me") return "delete-me";

  const client = await findClientByPhone(db, t, phone);
  if (!client) return print("עוד אין לקוח עם המזהה הזה. שלחו הודעה קודם.", "gray");

  switch (cmd) {
    case "profile": {
      print(`הסכמה: ${client.consentStatus} | דגלים: ${JSON.stringify(client.flags)} | מושהה: ${client.botPaused ? "כן" : "לא"}`, "gray");
      return print(describeProfile(await getProfile(db, t, client.id)));
    }
    case "logs": {
      const weights = await listWeights(db, t, client.id);
      const meals = await listMeals(db, t, client.id);
      const workouts = await listWorkouts(db, t, client.id);
      const lines = [
        `שקילות (${weights.length}):`,
        ...weights.slice(-10).map((w) => `  ${w.measuredOn}: ${w.weightKg} ק"ג`),
        `ארוחות (${meals.length}):`,
        ...meals.slice(-10).map((m) => `  ${m.eatenOn} ${m.mealType}: ${m.description}${m.estCalories ? ` (~${m.estCalories})` : ""}`),
        `אימונים (${workouts.length}):`,
        ...workouts.slice(-5).map((w) => `  ${w.performedOn} ${w.title}: ${w.exercises.map((e) => `${e.name} ${e.sets}x${e.reps}@${e.weightKg}`).join(", ")}`),
      ];
      return print(lines.join("\n"));
    }
    case "plans": {
      const meal = await getActiveMealPlan(db, t, client.id);
      const workout = await getActiveWorkoutPlan(db, t, client.id);
      print(meal ? `תפריט v${meal.version} (הערכה פנימית: ${meal.dailyCalories} קק"ל):\n${meal.planText}` : "אין עדיין תפריט.");
      console.log();
      return print(workout ? `תוכנית אימונים v${workout.version} (התקדמות: ${workout.progressionRule}):\n${workout.planText}` : "אין עדיין תוכנית אימונים.");
    }
    case "alerts": {
      const alerts = await listAlerts(db, t, { clientId: client.id });
      if (!alerts.length) return print("אין התראות.", "gray");
      return print(
        alerts
          .map((a) => `[${a.status}] ${a.createdAt.toISOString().slice(0, 16)} ${a.type}/${a.severity} (${a.source}): ${a.summary}${a.question ? `\n    שאלה: ${a.question}` : ""}`)
          .join("\n"),
      );
    }
    case "summary": {
      const memory = await getMemory(db, t, client.id);
      if (!memory) return print("עוד אין סיכום. הוא נוצר כשהאפיזודה מתמלאת, או עם /compact.", "gray");
      print(memory.summary || "(ריק)");
      if (memory.recent) {
        console.log();
        print(`הודעות אחרונות שהועברו לאפיזודה הבאה:\n${memory.recent}`, "gray");
      }
      return;
    }
    case "compact": {
      print("מסכם ופותח אפיזודה חדשה…", "gray");
      const events = await app.engine.compact(t.coachId, client.id);
      return print(events.length ? "בוצע. השתמשו ב-/summary כדי לראות את הסיכום." : "אין מה לסכם.", "gray");
    }
    case "pause":
    case "resume": {
      const paused = cmd === "pause";
      await updateClient(db, t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
      await audit(db, t, { actor: "cli-coach", action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
      return print(
        paused
          ? "(מאמן) הבוט מושהה. הודעות הלקוח יגיעו כהתראות; ענו עם /coach <טקסט>."
          : "(מאמן) הבוט חזר. בהודעה הבאה הוא יקבל את מה שנאמר בזמן ההשהיה.",
        "magenta",
      );
    }
    case "coach": {
      if (!arg) return print("כתבו: /coach <ההודעה של המאמן>", "gray");
      // In the CLI there's no WhatsApp to send through: log it the way a real coach message is logged.
      await logChatMessage(db, t, { clientId: client.id, direction: "out", sender: "coach", body: arg, botSeen: false });
      return print(`👤 ${t.coachName} (מאמן): ${arg}`, "magenta");
    }
    case "export": {
      const data = await exportClientData(db, t, client.id, "cli");
      mkdirSync(join(".data", "exports"), { recursive: true });
      const path = join(".data", "exports", `${phone}-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(data, null, 2));
      return print(`נשמר: ${path}`, "gray");
    }
    default:
      return print(`פקודה לא מוכרת: /${cmd}. כתבו /help`, "gray");
  }
}
