import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import {
  audit,
  clientPhone,
  connectWhatsAppNumber,
  createApiForAccount,
  createEmbedder,
  deleteClientData,
  exportClientData,
  findClientByPhone,
  generateKeyBase64,
  getCoachAccount,
  importCoachFromDir,
  listAlerts,
  listChatMessages,
  listClients,
  loadConfig,
  purgeInactiveClients,
  resolveAlert,
  sendCoachMessage,
  sendTemplateMessage,
  setClientFlags,
  updateClient,
  type DryRunEntry,
  type LlmClient,
  type TenantContext,
} from "@fitcoach/core";
import { bootstrap, type App } from "./bootstrap.js";
import { runChat } from "./chat.js";
import { simulateWebhook } from "./simulate.js";

const USAGE = `שימוש: npm run <פקודה> -- [אפשרויות]

  setup                          יוצר .env ומפתח הצפנה, ומוסיף הגדרות חדשות שחסרות
  seed                           טוען את מאמן הדמו
  coach:import <dir> [--slug x]  מייבא מאמן מתיקייה (coach.yaml + docs/)
  chat [--coach demo] [--phone id] [--debug] [--no-bidi] [--new]
  server                         שרת הוואטסאפ (webhook + worker)
  wa:simulate -- [--from 972...] [--pnid id] [--button id] [--type image] "טקסט"
                                 שולח לשרת webhook חתום כאילו מוואטסאפ (בלי Meta)

פקודות ניהול (npm run admin -- <פקודה> [--coach demo]):
  clients                        רשימת לקוחות
  history <phone>                השיחה עם לקוח, כולל סטטוס מסירה
  alerts [--all]                 התראות פתוחות (או כולן)
  alert:resolve <id> [--note x]  סגירת התראה
  pause <phone> / resume <phone> השהיית הבוט ללקוח (השתלטות של המאמן) והחזרתו
  send <phone> "טקסט"            הודעה מהמאמן ללקוח בוואטסאפ (בתוך חלון 24 השעות)
  send-template <phone> <name> [--lang he] [--params "א|ב"]
                                 תבנית מאושרת (גם מחוץ לחלון 24 השעות)
  wa:connect --pnid <id> [--display +972...] [--waba <id>]
                                 חיבור מספר וואטסאפ (phone_number_id) למאמן
  flags:clear <phone>            ניקוי דגלי בטיחות (קטין / הפרעת אכילה) אחרי בדיקה של המאמן
  export <phone>                 ייצוא כל המידע של לקוח
  delete <phone>                 מחיקה מלאה של לקוח
  purge                          מחיקת לקוחות לא פעילים לפי RETENTION_MONTHS`;

function setup() {
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("נוצר קובץ .env מתוך .env.example");
  }
  let env = readFileSync(".env", "utf8");
  if (/^MASTER_ENCRYPTION_KEY=\s*$/m.test(env)) {
    env = env.replace(/^MASTER_ENCRYPTION_KEY=\s*$/m, `MASTER_ENCRYPTION_KEY=${generateKeyBase64()}`);
    console.log("נוצר MASTER_ENCRYPTION_KEY חדש. שמרו גיבוי שלו במקום בטוח: בלעדיו אי אפשר לפענח את המידע.");
  } else {
    console.log("MASTER_ENCRYPTION_KEY כבר מוגדר, לא שיניתי אותו.");
  }
  // Settings added in later stages: append them (with their comments) without touching existing values.
  const present = new Set([...env.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const added: string[] = [];
  let comments: string[] = [];
  const block: string[] = [];
  for (const line of readFileSync(".env.example", "utf8").split(/\r?\n/)) {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (!key) {
      comments = line.trim() ? [...comments, line] : [];
      continue;
    }
    if (!present.has(key)) {
      block.push(...comments, line);
      added.push(key);
    }
    comments = [];
  }
  if (block.length) env = `${env.trimEnd()}\n\n${block.join("\n")}\n`;
  writeFileSync(".env", env);
  if (added.length) console.log(`נוספו ל-.env הגדרות חדשות: ${added.join(", ")}`);
  if (/^ANTHROPIC_API_KEY=\s*$/m.test(env)) {
    console.log(styleText("yellow", "נשאר לעשות: להדביק את ANTHROPIC_API_KEY בקובץ .env"));
  }
}

function optionalLlm(app: App): LlmClient | null {
  try {
    return app.llm();
  } catch {
    return null;
  }
}

function printDryRun(entry: DryRunEntry) {
  if (entry.type === "read") return;
  const body = entry.type === "template" ? `template ${entry.template?.name}: ${entry.template?.bodyParams.join(" | ")}` : entry.body;
  console.log(styleText("green", `[dry run → ${entry.to}] `) + body);
}

async function importCoach(app: App, dir: string, slug?: string) {
  const res = await importCoachFromDir(app.handle.db, resolve(dir), {
    cfg: app.cfg,
    llm: optionalLlm(app),
    embedder: createEmbedder(),
    slug,
  });
  console.log(`${res.created ? "נוצר מאמן חדש" : "עודכן מאמן קיים"}: ${res.slug} (גרסת ידע ${res.version})`);
  console.log(`מסמכים שנטענו: ${res.documents.length ? res.documents.join(", ") : "אין"}`);
  if (res.skipped.length) {
    console.log(styleText("yellow", `דולגו: ${res.skipped.join(", ")} (תמונות דורשות ANTHROPIC_API_KEY; פורמטים נתמכים: md, txt, pdf, docx, png, jpg, webp)`));
  }
  console.log(createEmbedder() ? "חיפוש וקטורי פעיל (OpenAI)." : "OPENAI_API_KEY לא מוגדר: החיפוש במסמכים יעבוד לפי מילות מפתח.");
}

async function coachApi(app: App, t: TenantContext) {
  const account = await getCoachAccount(app.handle.db, t);
  if (!account) throw new Error(`למאמן ${t.coachName} אין מספר וואטסאפ מחובר. הריצו קודם: npm run admin -- wa:connect --pnid <phone_number_id>`);
  return createApiForAccount(t, account, app.cfg, printDryRun);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      coach: { type: "string", default: "demo" },
      phone: { type: "string" },
      slug: { type: "string" },
      note: { type: "string" },
      pnid: { type: "string" },
      display: { type: "string" },
      waba: { type: "string" },
      from: { type: "string" },
      button: { type: "string" },
      type: { type: "string" },
      lang: { type: "string", default: "he" },
      params: { type: "string" },
      debug: { type: "boolean", default: false },
      "no-bidi": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
  });

  if (command === "setup") return setup();
  if (command === "help" || command === "--help") return console.log(USAGE);
  if (command === "wa:simulate") {
    // HTTP only: works while the server holds the local database.
    return simulateWebhook(loadConfig(), {
      phoneNumberId: values.pnid ?? "dryrun-demo",
      from: values.from ?? "972500000001",
      text: positionals.join(" "),
      buttonId: values.button,
      type: values.type,
    });
  }

  const app = await bootstrap();
  try {
    const db = app.handle.db;
    switch (command) {
      case "seed":
        return await importCoach(app, "seed/demo-coach", "demo");
      case "coach:import": {
        const dir = positionals[0];
        if (!dir) throw new Error("חסרה תיקייה: npm run coach:import -- <dir>");
        return await importCoach(app, dir, values.slug);
      }
      case "chat": {
        const phone = values.new ? `cli-${Math.random().toString(36).slice(2, 8)}` : (values.phone ?? "cli-demo-1");
        return await runChat(app, { coach: values.coach!, phone, debug: values.debug!, bidi: !values["no-bidi"] });
      }
    }

    const t = await app.tenant(values.coach!);
    const requireClient = async () => {
      const phone = positionals[0] ?? values.phone;
      if (!phone) throw new Error("חסר מזהה לקוח (טלפון)");
      const client = await findClientByPhone(db, t, phone);
      if (!client) throw new Error(`לא נמצא לקוח ${phone} אצל ${t.coachName}`);
      return client;
    };

    switch (command) {
      case "clients": {
        const rows = await listClients(db, t);
        if (!rows.length) return console.log("אין לקוחות.");
        for (const c of rows) {
          console.log(
            `${clientPhone(t, c)}  ${c.channel}  הסכמה:${c.consentStatus}  ${c.botPaused ? "מושהה  " : ""}${
              Object.keys(c.flags).length ? `דגלים:${JSON.stringify(c.flags)}` : ""
            }`,
          );
        }
        return;
      }
      case "history": {
        const client = await requireClient();
        for (const m of await listChatMessages(db, t, client.id)) {
          const who = { client: "לקוח", bot: "בוט", coach: "מאמן", system: "מערכת" }[m.sender];
          console.log(`${m.createdAt.toISOString().slice(0, 19)}  ${who}${m.status ? ` (${m.status})` : ""}: ${m.body ?? "[לא נשמר: לפני הסכמה]"}`);
        }
        return;
      }
      case "alerts": {
        const alerts = await listAlerts(db, t, values.all ? {} : { status: "open" });
        if (!alerts.length) return console.log("אין התראות.");
        for (const a of alerts) {
          console.log(`${a.id}  [${a.status}] ${a.type}/${a.severity}  ${a.summary}${a.question ? `  | שאלה: ${a.question}` : ""}`);
        }
        return;
      }
      case "alert:resolve": {
        const id = positionals[0];
        if (!id) throw new Error("חסר מזהה התראה");
        await resolveAlert(db, t, id, values.note ?? null);
        return console.log("ההתראה נסגרה.");
      }
      case "pause":
      case "resume": {
        const client = await requireClient();
        const paused = command === "pause";
        await updateClient(db, t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
        await audit(db, t, { actor: "cli", action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
        return console.log(
          paused
            ? "הבוט מושהה ללקוח הזה. ההודעות שלו יגיעו כהתראות, ואפשר לענות עם send."
            : "הבוט חזר לענות. בהודעה הבאה הוא יקבל את מה שנאמר בזמן ההשהיה.",
        );
      }
      case "send": {
        const client = await requireClient();
        const text = positionals.slice(1).join(" ").trim();
        if (!text) throw new Error('חסר טקסט: npm run admin -- send <phone> "הודעה"');
        const parts = await sendCoachMessage(db, t, client, await coachApi(app, t), text, { now: new Date(), actor: "cli" });
        return console.log(`נשלח (${parts} הודעות).`);
      }
      case "send-template": {
        const client = await requireClient();
        const name = positionals[1];
        if (!name) throw new Error("חסר שם תבנית");
        await sendTemplateMessage(
          db,
          t,
          client,
          await coachApi(app, t),
          { name, languageCode: values.lang!, bodyParams: values.params ? values.params.split("|").map((p) => p.trim()) : [] },
          { actor: "cli" },
        );
        return console.log("התבנית נשלחה.");
      }
      case "wa:connect": {
        if (!values.pnid) throw new Error("חסר --pnid (ה-phone_number_id מ-Meta)");
        const account = await connectWhatsAppNumber(db, t, { phoneNumberId: values.pnid, displayPhone: values.display, wabaId: values.waba });
        return console.log(`המספר ${account.phoneNumberId} מחובר למאמן ${t.coachName} (${account.mode}).`);
      }
      case "flags:clear": {
        const client = await requireClient();
        await setClientFlags(db, t, client, { minor: undefined, eatingDisorderRisk: undefined });
        await audit(db, t, { actor: "cli", action: "flags_cleared", targetType: "client", targetId: client.id });
        return console.log("דגלי הבטיחות נוקו. השינוי ייכנס לתוקף בשיחה הבאה.");
      }
      case "export": {
        const client = await requireClient();
        return console.log(JSON.stringify(await exportClientData(db, t, client.id, "cli"), null, 2));
      }
      case "delete": {
        const client = await requireClient();
        await deleteClientData(db, t, client.id, "cli");
        return console.log("הלקוח וכל המידע שלו נמחקו.");
      }
      case "purge": {
        const n = await purgeInactiveClients(db, t, app.cfg.RETENTION_MONTHS);
        return console.log(`נמחקו ${n} לקוחות לא פעילים.`);
      }
      default:
        console.log(USAGE);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(styleText("red", err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
