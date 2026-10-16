import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import {
  createEmbedder,
  deleteClientData,
  exportClientData,
  findClientByPhone,
  generateKeyBase64,
  importCoachFromDir,
  listAlerts,
  listClients,
  clientPhone,
  purgeInactiveClients,
  resolveAlert,
  setClientFlags,
  updateClient,
  audit,
  type LlmClient,
} from "@fitcoach/core";
import { bootstrap, type App } from "./bootstrap.js";
import { runChat } from "./chat.js";

const USAGE = `שימוש: npm run <פקודה> -- [אפשרויות]

  setup                          יוצר .env ומפתח הצפנה
  seed                           טוען את מאמן הדמו
  coach:import <dir> [--slug x]  מייבא מאמן מתיקייה (coach.yaml + docs/)
  chat [--coach demo] [--phone id] [--debug] [--no-bidi] [--new]

פקודות ניהול (npm run admin -- <פקודה> [--coach demo]):
  clients                        רשימת לקוחות
  alerts [--all]                 התראות פתוחות (או כולן)
  alert:resolve <id> [--note x]  סגירת התראה
  pause <phone> / resume <phone> השהיית הבוט ללקוח (השתלטות של המאמן) והחזרתו
  flags:clear <phone>            ניקוי דגלי בטיחות (קטין / הפרעת אכילה) אחרי בדיקה של המאמן
  export <phone>                 ייצוא כל המידע של לקוח
  delete <phone>                 מחיקה מלאה של לקוח
  purge                          מחיקת לקוחות לא פעילים לפי RETENTION_MONTHS`;

function setup() {
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("נוצר קובץ .env מתוך .env.example");
  }
  const env = readFileSync(".env", "utf8");
  if (/^MASTER_ENCRYPTION_KEY=\s*$/m.test(env)) {
    writeFileSync(".env", env.replace(/^MASTER_ENCRYPTION_KEY=\s*$/m, `MASTER_ENCRYPTION_KEY=${generateKeyBase64()}`));
    console.log("נוצר MASTER_ENCRYPTION_KEY חדש. שמרו גיבוי שלו במקום בטוח: בלעדיו אי אפשר לפענח את המידע.");
  } else {
    console.log("MASTER_ENCRYPTION_KEY כבר מוגדר, לא שיניתי אותו.");
  }
  if (/^ANTHROPIC_API_KEY=\s*$/m.test(readFileSync(".env", "utf8"))) {
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
      debug: { type: "boolean", default: false },
      "no-bidi": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
  });

  if (command === "setup") return setup();
  if (command === "help" || command === "--help") return console.log(USAGE);

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
    const requirePhone = async () => {
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
          console.log(`${clientPhone(t, c)}  הסכמה:${c.consentStatus}  ${c.botPaused ? "מושהה  " : ""}${Object.keys(c.flags).length ? `דגלים:${JSON.stringify(c.flags)}` : ""}`);
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
        const client = await requirePhone();
        const paused = command === "pause";
        await updateClient(db, t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
        await audit(db, t, { actor: "cli", action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
        return console.log(paused ? "הבוט מושהה ללקוח הזה. ההודעות שלו יגיעו כהתראות." : "הבוט חזר לענות ללקוח הזה.");
      }
      case "flags:clear": {
        const client = await requirePhone();
        await setClientFlags(db, t, client, { minor: undefined, eatingDisorderRisk: undefined });
        await audit(db, t, { actor: "cli", action: "flags_cleared", targetType: "client", targetId: client.id });
        return console.log("דגלי הבטיחות נוקו. השינוי ייכנס לתוקף בשיחה הבאה.");
      }
      case "export": {
        const client = await requirePhone();
        return console.log(JSON.stringify(await exportClientData(db, t, client.id, "cli"), null, 2));
      }
      case "delete": {
        const client = await requirePhone();
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
