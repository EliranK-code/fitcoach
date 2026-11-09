import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import {
  audit,
  createTranscriber,
  prepareImage,
  type InboundMessage,
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
import { renderForTerminal } from "./bidi";
import type { App } from "./bootstrap";

type Color = Parameters<typeof styleText>[0];

const HELP = `Commands:
/profile   The profile the bot collected
/logs      Weigh-ins, meals and workouts (30 days)
/plans     The current meal plan and workout plan
/alerts    Alerts opened for the coach about this client
/summary   Long-term memory (conversation summary)
/compact   Summarize now and start a new episode
/export    Export all of the client's data to a JSON file
/image <file> [caption]  Send a photo (for example of a meal)
/voice <file>  Send a voice message (needs OPENAI_API_KEY)
/delete-me Ask to delete your data (like a real client)
/debug     Show or hide tool calls and token usage
/new       Start over as a new client
/help      This help
/quit      Exit

As the coach (taking over the conversation):
/pause         Pause the bot for this client
/coach <text>  Write to the client as the coach
/resume        Bring the bot back (it gets what was said during the pause)`;

const SEVERITY_LABEL: Record<string, string> = { low: "low", medium: "medium", high: "high", urgent: "urgent" };

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
    writeFileSync(transcriptPath, `# Conversation with ${t.coachName}'s bot (client: ${phone})\n\n`);
  };
  const toTranscript = (who: string, text: string) =>
    appendFileSync(transcriptPath, `**${who}** (${localStamp(new Date(), app.cfg.TIMEZONE)}):\n\n${text}\n\n---\n\n`);

  const print = (text: string, color?: Color, indent = 0) => {
    const rendered = renderForTerminal(text, { bidi: opts.bidi, indent });
    console.log(color ? styleText(color, rendered) : rendered);
  };

  startTranscript();
  print(`Chat with ${t.coachName}'s bot. You're playing the client (id: ${phone}).`, "bold");
  print("Type /help for the list of commands. The transcript is saved at:", "gray");
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
      if (cmd === "image" || cmd === "voice") {
        await sendMedia(cmd, line.slice(cmd.length + 1).trim());
        rl.prompt();
        continue;
      }
      try {
        const result = await runCommand(app, t, phone, cmd, line.slice(cmd.length + 1).trim(), { print, debug });
        if (result === "toggle-debug") {
          debug = !debug;
          print(debug ? "Debug mode on" : "Debug mode off", "gray");
        } else if (result === "new-client") {
          phone = `cli-${Math.random().toString(36).slice(2, 8)}`;
          startTranscript();
          print(`New client: ${phone}`, "bold");
        } else if (result === "delete-me") {
          await send("delete my data");
        }
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`, "red");
      }
      rl.prompt();
      continue;
    }

    await send(line);
    rl.prompt();
  }

  rl.close();

  /** /image path [caption] and /voice path: the same paths WhatsApp photos and voice notes take. */
  async function sendMedia(kind: "image" | "voice", arg: string) {
    const [rawPath = "", ...captionParts] = arg.match(/"[^"]+"|\S+/g) ?? [];
    const path = resolve(rawPath.replace(/^"|"$/g, ""));
    if (!rawPath || !existsSync(path)) {
      print(`File not found: ${rawPath || "(none given)"}`, "red");
      return;
    }
    const data = readFileSync(path);
    if (kind === "image") {
      try {
        const image = await prepareImage(data);
        const caption = captionParts.join(" ");
        print(`📷 Photo ${image.width}×${image.height}${caption ? ` with the caption: ${caption}` : ""}`, "cyan");
        await send(caption, { image });
      } catch (err) {
        print(`Image error: ${err instanceof Error ? err.message : String(err)}`, "red");
      }
      return;
    }
    const transcriber = createTranscriber(app.cfg);
    if (!transcriber) {
      print("Transcribing voice messages needs OPENAI_API_KEY in .env", "red");
      return;
    }
    const mime = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav" }[extname(path).toLowerCase()] ?? "audio/ogg";
    print("🎙️ Transcribing…", "gray");
    try {
      const { text } = await transcriber.transcribe(data, mime);
      print(`Transcript: ${text}`, "gray");
      await send(text, { voice: true });
    } catch (err) {
      print(`Transcription error: ${err instanceof Error ? err.message : String(err)}`, "red");
    }
  }

  async function send(text: string, media: Pick<InboundMessage, "image" | "voice"> = {}) {
    if (!media.image && !media.voice) print(`You: ${text}`, "cyan");
    toTranscript("Client", media.image ? `[photo] ${text}` : media.voice ? `[voice message] ${text}` : text);
    if (tty) process.stdout.write(styleText("gray", "…\n"));
    let res: TurnResult;
    try {
      res = await app.engine.handleInbound({ coachId: t.coachId, phone, text, channel: "cli", isTest: true, ...media });
    } catch (err) {
      eraseLine();
      print(`Error: ${err instanceof Error ? err.message : String(err)}`, "red");
      return;
    }
    eraseLine();
    printEvents(res.events, debug, print);
    if (res.replies.length === 0) print("(The bot didn't answer: the conversation is paused for the coach)", "gray");
    for (const reply of res.replies) {
      console.log(styleText("green", renderForTerminal(`🤖 ${t.coachName} (bot):`, { bidi: opts.bidi })));
      print(reply);
      toTranscript("Bot", reply);
      console.log();
    }
    if (res.buttons?.length) print(`Buttons: ${res.buttons.map((b) => `[${b.title}]`).join("  ")}`, "gray");
    if (res.error) print(`Error details (for developers only): ${res.error}`, "red");
  }
}

function printEvents(events: TurnEvent[], debug: boolean, print: (text: string, color?: Color) => void) {
  for (const e of events) {
    if (e.type === "alert" && !e.deduped) {
      print(`⚠️  Alert to the coach: ${e.alertType} (severity ${SEVERITY_LABEL[e.severity] ?? e.severity}, source: ${e.source}) ${e.summary}`, "yellow");
    }
    if (!debug) continue;
    if (e.type === "tool") {
      const input = JSON.stringify(e.input);
      print(`🔧 ${e.name}${e.ok ? "" : " ✗"}: ${input.length > 300 ? `${input.slice(0, 300)}…` : input}`, "gray");
      print(`   ↳ ${e.result.length > 300 ? `${e.result.slice(0, 300)}…` : e.result}`, "gray");
    } else if (e.type === "epoch") {
      print(`🧠 ${e.action === "created" ? "New episode" : "New episode after a summary"} (${e.reason})`, "gray");
    } else if (e.type === "usage") {
      print(`📊 ${e.model}: input ${e.input}, cache read ${e.cacheRead}, cache write ${e.cacheWrite}, output ${e.output}`, "gray");
    } else if (e.type === "guard") {
      print(`🛡️  ${e.detail}`, "gray");
    } else if (e.type === "refusal") {
      print(`🚫 The AI model refused (category: ${e.category ?? "unknown"})`, "gray");
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
  if (!client) return print("No client with this id yet. Send a message first.", "gray");

  switch (cmd) {
    case "profile": {
      print(`Consent: ${client.consentStatus} | flags: ${JSON.stringify(client.flags)} | paused: ${client.botPaused ? "yes" : "no"}`, "gray");
      return print(describeProfile(await getProfile(db, t, client.id)));
    }
    case "logs": {
      const weights = await listWeights(db, t, client.id);
      const meals = await listMeals(db, t, client.id);
      const workouts = await listWorkouts(db, t, client.id);
      const lines = [
        `Weigh-ins (${weights.length}):`,
        ...weights.slice(-10).map((w) => `  ${w.measuredOn}: ${w.weightKg} kg`),
        `Meals (${meals.length}):`,
        ...meals.slice(-10).map((m) => `  ${m.eatenOn} ${m.mealType}: ${m.description}${m.estCalories ? ` (~${m.estCalories})` : ""}`),
        `Workouts (${workouts.length}):`,
        ...workouts.slice(-5).map((w) => `  ${w.performedOn} ${w.title}: ${w.exercises.map((e) => `${e.name} ${e.sets}x${e.reps}@${e.weightKg}`).join(", ")}`),
      ];
      return print(lines.join("\n"));
    }
    case "plans": {
      const meal = await getActiveMealPlan(db, t, client.id);
      const workout = await getActiveWorkoutPlan(db, t, client.id);
      print(meal ? `Meal plan v${meal.version} (internal estimate: ${meal.dailyCalories} kcal):\n${meal.planText}` : "No meal plan yet.");
      console.log();
      return print(workout ? `Workout plan v${workout.version} (progression: ${workout.progressionRule}):\n${workout.planText}` : "No workout plan yet.");
    }
    case "alerts": {
      const alerts = await listAlerts(db, t, { clientId: client.id });
      if (!alerts.length) return print("No alerts.", "gray");
      return print(
        alerts
          .map((a) => `[${a.status}] ${a.createdAt.toISOString().slice(0, 16)} ${a.type}/${a.severity} (${a.source}): ${a.summary}${a.question ? `\n    question: ${a.question}` : ""}`)
          .join("\n"),
      );
    }
    case "summary": {
      const memory = await getMemory(db, t, client.id);
      if (!memory) return print("No summary yet. It's created when the episode fills up, or with /compact.", "gray");
      print(memory.summary || "(empty)");
      if (memory.recent) {
        console.log();
        print(`Recent messages carried into the next episode:\n${memory.recent}`, "gray");
      }
      return;
    }
    case "compact": {
      print("Summarizing and starting a new episode…", "gray");
      const events = await app.engine.compact(t.coachId, client.id);
      return print(events.length ? "Done. Use /summary to see the summary." : "Nothing to summarize.", "gray");
    }
    case "pause":
    case "resume": {
      const paused = cmd === "pause";
      await updateClient(db, t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
      await audit(db, t, { actor: "cli-coach", action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
      return print(
        paused
          ? "(coach) The bot is paused. The client's messages arrive as alerts; reply with /coach <text>."
          : "(coach) The bot is back. On the next message it gets what was said during the pause.",
        "magenta",
      );
    }
    case "coach": {
      if (!arg) return print("Write: /coach <the coach's message>", "gray");
      // In the CLI there's no WhatsApp to send through: log it the way a real coach message is logged.
      await logChatMessage(db, t, { clientId: client.id, direction: "out", sender: "coach", body: arg, botSeen: false });
      return print(`👤 ${t.coachName} (coach): ${arg}`, "magenta");
    }
    case "export": {
      const data = await exportClientData(db, t, client.id, "cli");
      mkdirSync(join(".data", "exports"), { recursive: true });
      const path = join(".data", "exports", `${phone}-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(data, null, 2));
      return print(`Saved: ${path}`, "gray");
    }
    default:
      return print(`Unknown command: /${cmd}. Type /help`, "gray");
  }
}
