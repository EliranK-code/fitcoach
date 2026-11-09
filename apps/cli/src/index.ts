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
  listDemoCoaches,
  listPlatformAdmins,
  openTenant,
  removeDemoCoaches,
  updateCoach,
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

const USAGE = `Usage: npm run <command> -- [options]

  setup                          Creates .env and an encryption key, and adds new settings that are missing
  seed                           Loads the demo coach
  coach:import <dir> [--slug x]  Imports a coach from a folder (coach.yaml + docs/)
  chat [--coach demo] [--phone id] [--debug] [--no-bidi] [--new]
  server                         The WhatsApp server (webhook + worker)
  wa:simulate -- [--from 1415...] [--pnid id] [--button id] [--file photo.jpg|voice.ogg] "text"
                                 Sends the server a signed webhook as if from WhatsApp (no Meta)

Coach commands (npm run admin -- <command> [--coach demo]):
  clients                        List clients
  client:approve <phone>         Approve a WhatsApp number so the bot answers it (also a number that hasn't written yet).
                                 International form (+14155550123); a local number needs DEFAULT_COUNTRY_CODE
  client:revoke <phone>          Remove a client's access to the bot (their data is kept)
  history <phone>                The conversation with a client, with delivery status
  alerts [--all]                 Open alerts (or all)
  alert:resolve <id> [--note x]  Close an alert
  pause <phone> / resume <phone> Pause the bot for a client (coach takeover) and resume it
  send <phone> "text"            A message from the coach to the client on WhatsApp (inside the 24-hour window)
  send-template <phone> <name> [--lang en] [--params "a|b"]
                                 An approved template (also outside the 24-hour window)
  wa:connect --pnid <id> [--display +1...] [--waba <id>]
                                 Connect a WhatsApp number (phone_number_id) to the coach
  user:create --email <email>    A user for the coach's dashboard (the password is printed once)
  user:reset-password --email <email>
                                 A new password for a user (signs out all their sessions)
  user:delete --email <email>    Delete a dashboard user
  flags:clear <phone>            Clear safety flags (minor / eating disorder) after the coach checked
  export <phone>                 Export all of a client's data
  delete <phone>                 Delete a client completely
  purge                          Delete inactive clients by RETENTION_MONTHS
  sample-data [--remove]         Sample clients for the dashboard (no AI), or remove them

Coach management (platform):
  coach:list                     All coaches: status, clients and usage this month
  coach:suspend <slug>           Suspend: the bot doesn't answer (one fixed notice per client), no sign-in, reminders stop
  coach:resume <slug>            Lift the suspension
  coach:delete <slug> --confirm <slug>
                                 Permanently delete a suspended coach and all their data
  demo:remove [--confirm demo]   Delete the demo coach (and any coach marked as demo) with all their data. Without --confirm it only shows what would be deleted
  superadmin:create --email <email>
                                 An admin for the /admin panel (the password is printed once, two-step verification on first sign-in)
  superadmin:reset --email <email>
                                 A new admin password, resets two-step verification and signs out sessions
  superadmin:delete --email <email> / superadmin:list
  user:reset-mfa --email <email> [--coach demo]
                                 Turn off two-step verification for a coach user (for example after they lost their phone))`;

function setup() {
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("Created .env from .env.example");
  }
  let env = readFileSync(".env", "utf8");
  if (/^MASTER_ENCRYPTION_KEY=\s*$/m.test(env)) {
    env = env.replace(/^MASTER_ENCRYPTION_KEY=\s*$/m, `MASTER_ENCRYPTION_KEY=${generateKeyBase64()}`);
    console.log("Created a new MASTER_ENCRYPTION_KEY. Keep a backup of it somewhere safe: without it the data can't be decrypted.");
  } else {
    console.log("MASTER_ENCRYPTION_KEY is already set; left it unchanged.");
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
  if (added.length) console.log(`Added new settings to .env: ${added.join(", ")}`);
  if (/^ANTHROPIC_API_KEY=\s*$/m.test(env)) {
    console.log(styleText("yellow", "Left to do: paste your ANTHROPIC_API_KEY into .env"));
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

async function importCoach(app: App, dir: string, slug?: string, opts: { demo?: boolean } = {}) {
  const res = await importCoachFromDir(app.handle.db, resolve(dir), {
    cfg: app.cfg,
    llm: optionalLlm(app),
    embedder: createEmbedder(),
    slug,
  });
  if (opts.demo) {
    // Marked so `npm run demo:remove` can delete it before real coaches join.
    await updateCoach(app.handle.db, await openTenant(app.handle.db, res.coachId, { allowSuspended: true }), { settings: { demo: true } });
  }
  console.log(`${res.created ? "Created a new coach" : "Updated an existing coach"}: ${res.slug} (knowledge version ${res.version})${opts.demo ? ", marked as a demo coach" : ""}`);
  console.log(`Documents loaded: ${res.documents.length ? res.documents.join(", ") : "none"}`);
  if (res.skipped.length) {
    console.log(styleText("yellow", `Skipped: ${res.skipped.join(", ")} (images need ANTHROPIC_API_KEY; supported formats: md, txt, pdf, docx, png, jpg, webp)`));
  }
  console.log(createEmbedder() ? "Vector search is on (OpenAI)." : "OPENAI_API_KEY isn't set: document search will use keywords.");
}

async function coachApi(app: App, t: TenantContext) {
  const account = await getCoachAccount(app.handle.db, t);
  if (!account) throw new Error(`Coach ${t.coachName} has no WhatsApp number connected. First run: npm run admin -- wa:connect --pnid <phone_number_id>`);
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
        return await importCoach(app, "seed/demo-coach", "demo", { demo: true });
      case "coach:import": {
        const dir = positionals[0];
        if (!dir) throw new Error("Missing folder: npm run coach:import -- <dir>");
        return await importCoach(app, dir, values.slug);
      }
      case "chat": {
        const phone = values.new ? `cli-${Math.random().toString(36).slice(2, 8)}` : (values.phone ?? "cli-demo-1");
        return await runChat(app, { coach: values.coach!, phone, debug: values.debug!, bidi: !values["no-bidi"] });
      }
      case "superadmin:create":
      case "superadmin:reset": {
        if (!values.email) throw new Error("Missing --email");
        const password = generatePassword();
        if (command === "superadmin:create") {
          await createPlatformAdmin(db, values.email, password);
        } else {
          const admin = await findPlatformAdmin(db, values.email);
          if (!admin) throw new Error(`No admin ${values.email}`);
          await resetPlatformAdmin(db, admin.id, password);
        }
        const email = values.email.toLowerCase();
        await recordPlatformAction(db, { actor: "cli", action: command === "superadmin:create" ? "admin_created" : "admin_reset", meta: { email } });
        console.log(`Admin: ${email}`);
        console.log(`Password: ${styleText("bold", password)}`);
        return console.log(styleText("yellow", "The password is shown only once. When you sign in to /admin you'll be asked to scan a QR code with an authenticator app."));
      }
      case "superadmin:delete": {
        if (!values.email) throw new Error("Missing --email");
        const admin = await findPlatformAdmin(db, values.email);
        if (!admin) throw new Error(`No admin ${values.email}`);
        await deletePlatformAdmin(db, admin.id);
        await recordPlatformAction(db, { actor: "cli", action: "admin_deleted", meta: { email: admin.email } });
        return console.log(`Admin ${admin.email} deleted.`);
      }
      case "superadmin:list": {
        const admins = await listPlatformAdmins(db);
        if (!admins.length) return console.log("No admins. Create one with superadmin:create --email ...");
        for (const a of admins) {
          console.log(`${a.email}  ${a.totpEnabledAt ? "two-step verification on" : "two-step verification not set up yet"}  last sign-in:${a.lastLoginAt?.toISOString().slice(0, 16) ?? "-"}`);
        }
        return;
      }
      case "coach:list": {
        for (const c of await listCoaches(db)) {
          const status = c.status === "suspended" ? styleText("yellow", `suspended since ${c.suspendedAt?.toISOString().slice(0, 10)}`) : "active";
          console.log(`${c.slug}  ${c.name}  ${status}  clients:${c.clients}  tokens this month:${c.monthTokens.toLocaleString("en-US")}`);
        }
        return;
      }
      case "demo:remove": {
        const demos = await listDemoCoaches(db);
        if (!demos.length) return console.log("No demo coaches.");
        if (values.confirm !== "demo") {
          for (const c of demos) console.log(`${c.slug}  ${c.name}`);
          return console.log(styleText("yellow", "These coaches would be deleted permanently, with all their clients and data. To delete: npm run demo:remove -- --confirm demo"));
        }
        for (const summary of await removeDemoCoaches(db, "cli")) {
          console.log(`${summary.name} (${summary.slug}) deleted, with ${summary.clients} clients. The usage summary is kept in platform_audit.`);
        }
        return;
      }
      case "coach:suspend":
      case "coach:resume":
      case "coach:delete": {
        // The slug is positional on purpose: these never fall back to the default --coach.
        const slug = positionals[0];
        if (!slug) throw new Error(`Missing slug: npm run admin -- ${command} <slug>`);
        const coach = await findCoachBySlug(db, slug);
        if (command === "coach:suspend") {
          const done = await suspendCoach(db, coach.id, "cli");
          return console.log(done ? `${coach.name} (${slug}) suspended. Sessions were signed out, and the queue and reminders stopped.` : `${slug} is already suspended.`);
        }
        if (command === "coach:resume") {
          const done = await resumeCoach(db, coach.id, "cli", app.cfg);
          return console.log(done ? `${coach.name} (${slug}) is active again.` : `${slug} wasn't suspended.`);
        }
        const summary = await deleteCoach(db, coach.id, { actor: "cli", confirmSlug: values.confirm ?? "" });
        const tokens = summary.usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        return console.log(
          `${summary.name} (${slug}) permanently deleted, with ${summary.clients} clients. The usage summary (${tokens.toLocaleString("en-US")} tokens) is kept in platform_audit.`,
        );
      }
    }

    const t = await app.tenant(values.coach!);
    const requireClient = async () => {
      const phone = positionals[0] ?? values.phone;
      if (!phone) throw new Error("Missing client id (phone)");
      const client = await findClientByPhone(db, t, phone);
      if (!client) throw new Error(`No client ${phone} for ${t.coachName}`);
      return client;
    };

    switch (command) {
      case "clients": {
        const rows = await listClients(db, t);
        if (!rows.length) return console.log("No clients.");
        for (const c of rows) {
          console.log(
            `${clientPhone(t, c)}  ${c.channel}  ${c.approvedAt ? "" : "not approved  "}consent:${c.consentStatus}  ${c.botPaused ? "paused  " : ""}${
              Object.keys(c.flags).length ? `flags:${JSON.stringify(c.flags)}` : ""
            }`,
          );
        }
        return;
      }
      case "client:approve": {
        const phone = positionals[0] ?? values.phone;
        if (!phone) throw new Error("Missing phone number");
        const { client, created } = await addApprovedClient(db, t, phone, "cli");
        return console.log(`${clientPhone(t, client)} ${created ? "added and approved" : "approved"} for ${t.coachName}.`);
      }
      case "client:revoke": {
        const client = await requireClient();
        await revokeClientAccess(db, t, client.id, "cli");
        return console.log(`Removed ${clientPhone(t, client)}'s access to the bot.`);
      }
      case "history": {
        const client = await requireClient();
        for (const m of await listChatMessages(db, t, client.id)) {
          const who = { client: "client", bot: "bot", coach: "coach", system: "system" }[m.sender];
          console.log(`${m.createdAt.toISOString().slice(0, 19)}  ${who}${m.status ? ` (${m.status})` : ""}: ${m.body ?? "[not stored: before consent]"}`);
        }
        return;
      }
      case "alerts": {
        const alerts = await listAlerts(db, t, values.all ? {} : { status: "open" });
        if (!alerts.length) return console.log("No alerts.");
        for (const a of alerts) {
          console.log(`${a.id}  [${a.status}] ${a.type}/${a.severity}  ${a.summary}${a.question ? `  | question: ${a.question}` : ""}`);
        }
        return;
      }
      case "alert:resolve": {
        const id = positionals[0];
        if (!id) throw new Error("Missing alert id");
        await resolveAlert(db, t, id, values.note ?? null);
        return console.log("Alert closed.");
      }
      case "pause":
      case "resume": {
        const client = await requireClient();
        const paused = command === "pause";
        await updateClient(db, t, client.id, { botPaused: paused, pausedAt: paused ? new Date() : null });
        await audit(db, t, { actor: "cli", action: paused ? "bot_paused" : "bot_resumed", targetType: "client", targetId: client.id });
        return console.log(
          paused
            ? "The bot is paused for this client. Their messages arrive as alerts, and you can reply with send."
            : "The bot answers again. On the next message it gets what was said during the pause.",
        );
      }
      case "send": {
        const client = await requireClient();
        const text = positionals.slice(1).join(" ").trim();
        if (!text) throw new Error('Missing text: npm run admin -- send <phone> "message"');
        const parts = await sendCoachMessage(db, t, client, await coachApi(app, t), text, { now: new Date(), actor: "cli" });
        return console.log(`Sent (${parts} messages).`);
      }
      case "send-template": {
        const client = await requireClient();
        const name = positionals[1];
        if (!name) throw new Error("Missing template name");
        await sendTemplateMessage(
          db,
          t,
          client,
          await coachApi(app, t),
          { name, languageCode: values.lang!, bodyParams: values.params ? values.params.split("|").map((p) => p.trim()) : [] },
          { actor: "cli" },
        );
        return console.log("Template sent.");
      }
      case "wa:connect": {
        if (!values.pnid) throw new Error("Missing --pnid (the phone_number_id from Meta)");
        const account = await connectWhatsAppNumber(db, t, { phoneNumberId: values.pnid, displayPhone: values.display, wabaId: values.waba });
        return console.log(`Number ${account.phoneNumberId} is connected to coach ${t.coachName} (${account.mode}).`);
      }
      case "user:create":
      case "user:reset-password": {
        if (!values.email) throw new Error("Missing --email");
        const password = generatePassword();
        if (command === "user:create") {
          await createCoachUser(db, { coachId: t.coachId, email: values.email, password });
        } else {
          const user = await findUserByEmail(db, values.email);
          if (!user || user.coachId !== t.coachId) throw new Error(`No user ${values.email} for ${t.coachName}`);
          await setPassword(db, user.id, password);
        }
        await audit(db, t, { actor: "cli", action: command === "user:create" ? "user_created" : "password_reset", targetType: "user", targetId: values.email });
        console.log(`User: ${values.email.toLowerCase()}`);
        console.log(`Password: ${styleText("bold", password)}`);
        return console.log(styleText("yellow", "The password is shown only once. It can be changed in the dashboard, on the Settings page."));
      }
      case "user:reset-mfa": {
        if (!values.email) throw new Error("Missing --email");
        const user = await findUserByEmail(db, values.email);
        if (!user || user.coachId !== t.coachId) throw new Error(`No user ${values.email} for ${t.coachName}`);
        await clearTotp(db, user.id);
        await audit(db, t, { actor: "cli", action: "mfa_reset", targetType: "user", targetId: values.email });
        return console.log(`Two-step verification for ${values.email} is off. It can be turned on again in the dashboard, on the Settings page.`);
      }
      case "user:delete": {
        if (!values.email) throw new Error("Missing --email");
        const user = await findUserByEmail(db, values.email);
        if (!user || user.coachId !== t.coachId) throw new Error(`No user ${values.email} for ${t.coachName}`);
        // The user's playground test client goes too.
        const playground = await findClientByPhone(db, t, `playground:${user.id}`);
        if (playground) await deleteClientData(db, t, playground.id, "cli");
        await deleteCoachUser(db, user.id);
        await audit(db, t, { actor: "cli", action: "user_deleted", targetType: "user", targetId: values.email });
        return console.log(`User ${values.email} deleted.`);
      }
      case "sample-data": {
        if (values.remove) return console.log(`Removed ${await removeSampleData(db, t)} sample clients.`);
        await removeSampleData(db, t);
        return console.log(`Created ${await createSampleData(db, t)} sample clients. To remove: npm run admin -- sample-data --remove`);
      }
      case "flags:clear": {
        const client = await requireClient();
        await setClientFlags(db, t, client, { minor: undefined, eatingDisorderRisk: undefined });
        await audit(db, t, { actor: "cli", action: "flags_cleared", targetType: "client", targetId: client.id });
        return console.log("Safety flags cleared. The change takes effect on the next conversation.");
      }
      case "export": {
        const client = await requireClient();
        return console.log(JSON.stringify(await exportClientData(db, t, client.id, "cli"), null, 2));
      }
      case "delete": {
        const client = await requireClient();
        await deleteClientData(db, t, client.id, "cli");
        return console.log("The client and all their data were deleted.");
      }
      case "purge": {
        const n = await purgeInactiveClients(db, t, app.cfg.RETENTION_MONTHS);
        return console.log(`Deleted ${n} inactive clients.`);
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
