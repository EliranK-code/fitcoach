import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import {
  addApprovedClient,
  audit,
  clientPhone,
  connectWhatsAppNumber,
  createCoachUser,
  deleteCoachUser,
  findUserByEmail,
  generatePassword,
  setPassword,
  createApiForAccount,
  createEmbedder,
  deleteClientData,
  clearTotp,
  createPlatformAdmin,
  deleteCoach,
  deletePlatformAdmin,
  findCoachBySlug,
  findPlatformAdmin,
  listCoaches,
  listPlatformAdmins,
  recordPlatformAction,
  resetPlatformAdmin,
  resumeCoach,
  suspendCoach,
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
  revokeClientAccess,
  sendCoachMessage,
  sendTemplateMessage,
  setClientFlags,
  updateClient,
  type DryRunEntry,
  type LlmClient,
  type TenantContext,
} from "@fitcoach/core";
import { bootstrap, type App } from "./bootstrap";
import { runChat } from "./chat";
import { createSampleData, removeSampleData } from "./sample-data";
import { simulateWebhook } from "./simulate";

const USAGE = `שימוש: npm run <פקודה> -- [אפשרויות]

  setup                          יוצר .env ומפתח הצפנה, ומוסיף הגדרות חדשות שחסרות
  seed                           טוען את מאמן הדמו
  coach:import <dir> [--slug x]  מייבא מאמן מתיקייה (coach.yaml + docs/)
  chat [--coach demo] [--phone id] [--debug] [--no-bidi] [--new]
  server                         שרת הוואטסאפ (webhook + worker)
  wa:simulate -- [--from 972...] [--pnid id] [--button id] [--file photo.jpg|voice.ogg] "טקסט"
                                 שולח לשרת webhook חתום כאילו מוואטסאפ (בלי Meta)

פקודות ניהול (npm run admin -- <פקודה> [--coach demo]):
  clients                        רשימת לקוחות
  client:approve <phone>         אישור מספר וואטסאפ, כדי שהבוט יענה לו (גם מספר שעוד לא כתב)
  client:revoke <phone>          הסרת הגישה של לקוח לבוט (המידע נשמר)
  history <phone>                השיחה עם לקוח, כולל סטטוס מסירה
  alerts [--all]                 התראות פתוחות (או כולן)
  alert:resolve <id> [--note x]  סגירת התראה
  pause <phone> / resume <phone> השהיית הבוט ללקוח (השתלטות של המאמן) והחזרתו
  send <phone> "טקסט"            הודעה מהמאמן ללקוח בוואטסאפ (בתוך חלון 24 השעות)
  send-template <phone> <name> [--lang he] [--params "א|ב"]
                                 תבנית מאושרת (גם מחוץ לחלון 24 השעות)
  wa:connect --pnid <id> [--display +972...] [--waba <id>]
                                 חיבור מספר וואטסאפ (phone_number_id) למאמן
  user:create --email <email>    משתמש לדשבורד של המאמן (הסיסמה מודפסת פעם אחת)
  user:reset-password --email <email>
                                 סיסמה חדשה למשתמש (מנתק את כל הסשנים שלו)
  user:delete --email <email>    מחיקת משתמש דשבורד
  flags:clear <phone>            ניקוי דגלי בטיחות (קטין / הפרעת אכילה) אחרי בדיקה של המאמן
  export <phone>                 ייצוא כל המידע של לקוח
  delete <phone>                 מחיקה מלאה של לקוח
  purge                          מחיקת לקוחות לא פעילים לפי RETENTION_MONTHS
  sample-data [--remove]         לקוחות לדוגמה לדשבורד (בלי AI), או הסרתם

ניהול מאמנים (פלטפורמה):
  coach:list                     כל המאמנים: סטטוס, לקוחות ושימוש החודש
  coach:suspend <slug>           השעיה: הבוט לא עונה (הודעה קבועה אחת ללקוח), אין התחברות, התזכורות נעצרות
  coach:resume <slug>            ביטול ההשעיה
  coach:delete <slug> --confirm <slug>
                                 מחיקה לצמיתות של מאמן מושהה וכל המידע שלו
  superadmin:create --email <email>
                                 אדמין לפאנל /admin (הסיסמה מודפסת פעם אחת, אימות דו-שלבי בכניסה הראשונה)
  superadmin:reset --email <email>
                                 סיסמה חדשה לאדמין, איפוס האימות הדו-שלבי וניתוק הסשנים
  superadmin:delete --email <email> / superadmin:list
  user:reset-mfa --email <email> [--coach demo]
                                 ביטול האימות הדו-שלבי של משתמש מאמן (למשל אחרי שאיבד את הטלפון)`;

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
      file: { type: "string" },
      lang: { type: "string", default: "he" },
      params: { type: "string" },
      email: { type: "string" },
      confirm: { type: "string" },
      debug: { type: "boolean", default: false },
      "no-bidi": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
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
      file: values.file,
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
      case "superadmin:create":
      case "superadmin:reset": {
        if (!values.email) throw new Error("חסר --email");
        const password = generatePassword();
        if (command === "superadmin:create") {
          await createPlatformAdmin(db, values.email, password);
        } else {
          const admin = await findPlatformAdmin(db, values.email);
          if (!admin) throw new Error(`לא נמצא אדמין ${values.email}`);
          await resetPlatformAdmin(db, admin.id, password);
        }
        const email = values.email.toLowerCase();
        await recordPlatformAction(db, { actor: "cli", action: command === "superadmin:create" ? "admin_created" : "admin_reset", meta: { email } });
        console.log(`אדמין: ${email}`);
        console.log(`סיסמה: ${styleText("bold", password)}`);
        return console.log(styleText("yellow", "הסיסמה מוצגת פעם אחת בלבד. בכניסה ל-/admin תתבקשו לסרוק קוד QR באפליקציית אימות."));
      }
      case "superadmin:delete": {
        if (!values.email) throw new Error("חסר --email");
        const admin = await findPlatformAdmin(db, values.email);
        if (!admin) throw new Error(`לא נמצא אדמין ${values.email}`);
        await deletePlatformAdmin(db, admin.id);
        await recordPlatformAction(db, { actor: "cli", action: "admin_deleted", meta: { email: admin.email } });
        return console.log(`האדמין ${admin.email} נמחק.`);
      }
      case "superadmin:list": {
        const admins = await listPlatformAdmins(db);
        if (!admins.length) return console.log("אין אדמינים. יוצרים עם superadmin:create --email ...");
        for (const a of admins) {
          console.log(`${a.email}  ${a.totpEnabledAt ? "אימות דו-שלבי פעיל" : "עוד לא הגדיר אימות"}  כניסה אחרונה:${a.lastLoginAt?.toISOString().slice(0, 16) ?? "-"}`);
        }
        return;
      }
      case "coach:list": {
        for (const c of await listCoaches(db)) {
          const status = c.status === "suspended" ? styleText("yellow", `מושהה מ-${c.suspendedAt?.toISOString().slice(0, 10)}`) : "פעיל";
          console.log(`${c.slug}  ${c.name}  ${status}  לקוחות:${c.clients}  טוקנים החודש:${c.monthTokens.toLocaleString("he-IL")}`);
        }
        return;
      }
      case "coach:suspend":
      case "coach:resume":
      case "coach:delete": {
        // The slug is positional on purpose: these never fall back to the default --coach.
        const slug = positionals[0];
        if (!slug) throw new Error(`חסר slug: npm run admin -- ${command} <slug>`);
        const coach = await findCoachBySlug(db, slug);
        if (command === "coach:suspend") {
          const done = await suspendCoach(db, coach.id, "cli");
          return console.log(done ? `${coach.name} (${slug}) הושעה. הסשנים נותקו, והתור והתזכורות נעצרו.` : `${slug} כבר מושהה.`);
        }
        if (command === "coach:resume") {
          const done = await resumeCoach(db, coach.id, "cli", app.cfg);
          return console.log(done ? `${coach.name} (${slug}) פעיל שוב.` : `${slug} לא היה מושהה.`);
        }
        const summary = await deleteCoach(db, coach.id, { actor: "cli", confirmSlug: values.confirm ?? "" });
        const tokens = summary.usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        return console.log(
          `${summary.name} (${slug}) נמחק לצמיתות, עם ${summary.clients} לקוחות. סיכום השימוש (${tokens.toLocaleString("he-IL")} טוקנים) נשמר ב-platform_audit.`,
        );
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
            `${clientPhone(t, c)}  ${c.channel}  ${c.approvedAt ? "" : "לא מאושר  "}הסכמה:${c.consentStatus}  ${c.botPaused ? "מושהה  " : ""}${
              Object.keys(c.flags).length ? `דגלים:${JSON.stringify(c.flags)}` : ""
            }`,
          );
        }
        return;
      }
      case "client:approve": {
        const phone = positionals[0] ?? values.phone;
        if (!phone) throw new Error("חסר מספר טלפון");
        const { client, created } = await addApprovedClient(db, t, phone, "cli");
        return console.log(`${clientPhone(t, client)} ${created ? "נוסף ואושר" : "מאושר"} אצל ${t.coachName}.`);
      }
      case "client:revoke": {
        const client = await requireClient();
        await revokeClientAccess(db, t, client.id, "cli");
        return console.log(`הגישה של ${clientPhone(t, client)} לבוט הוסרה.`);
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
      case "user:create":
      case "user:reset-password": {
        if (!values.email) throw new Error("חסר --email");
        const password = generatePassword();
        if (command === "user:create") {
          await createCoachUser(db, { coachId: t.coachId, email: values.email, password });
        } else {
          const user = await findUserByEmail(db, values.email);
          if (!user || user.coachId !== t.coachId) throw new Error(`לא נמצא משתמש ${values.email} אצל ${t.coachName}`);
          await setPassword(db, user.id, password);
        }
        await audit(db, t, { actor: "cli", action: command === "user:create" ? "user_created" : "password_reset", targetType: "user", targetId: values.email });
        console.log(`משתמש: ${values.email.toLowerCase()}`);
        console.log(`סיסמה: ${styleText("bold", password)}`);
        return console.log(styleText("yellow", "הסיסמה מוצגת פעם אחת בלבד. אפשר להחליף אותה בדשבורד, בעמוד ההגדרות."));
      }
      case "user:reset-mfa": {
        if (!values.email) throw new Error("חסר --email");
        const user = await findUserByEmail(db, values.email);
        if (!user || user.coachId !== t.coachId) throw new Error(`לא נמצא משתמש ${values.email} אצל ${t.coachName}`);
        await clearTotp(db, user.id);
        await audit(db, t, { actor: "cli", action: "mfa_reset", targetType: "user", targetId: values.email });
        return console.log(`האימות הדו-שלבי של ${values.email} בוטל. אפשר להפעיל אותו מחדש בדשבורד, בעמוד ההגדרות.`);
      }
      case "user:delete": {
        if (!values.email) throw new Error("חסר --email");
        const user = await findUserByEmail(db, values.email);
        if (!user || user.coachId !== t.coachId) throw new Error(`לא נמצא משתמש ${values.email} אצל ${t.coachName}`);
        // The user's playground test client goes too.
        const playground = await findClientByPhone(db, t, `playground:${user.id}`);
        if (playground) await deleteClientData(db, t, playground.id, "cli");
        await deleteCoachUser(db, user.id);
        await audit(db, t, { actor: "cli", action: "user_deleted", targetType: "user", targetId: values.email });
        return console.log(`המשתמש ${values.email} נמחק.`);
      }
      case "sample-data": {
        if (values.remove) return console.log(`נמחקו ${await removeSampleData(db, t)} לקוחות לדוגמה.`);
        await removeSampleData(db, t);
        return console.log(`נוצרו ${await createSampleData(db, t)} לקוחות לדוגמה. להסרה: npm run admin -- sample-data --remove`);
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
