import { styleText } from "node:util";
import {
  ConversationEngine,
  createAnthropicLlm,
  createApiForAccount,
  createEmbedder,
  createTranscriber,
  getCoachAccount,
  ReminderScheduler,
  findAccountByPhoneNumberId,
  InboundWorker,
  loadConfig,
  logger,
  maskPhone,
  openDatabase,
  WhatsAppConfigError,
  type DryRunEntry,
  type LlmClient,
} from "@fitcoach/core";
import { buildServer } from "./app";

// Dry run prints the outgoing text on purpose (it's the simulation), but only the last digits of the number.
function printDryRun(entry: DryRunEntry) {
  if (entry.type === "read") return;
  const head = styleText("green", `[dry run → ${maskPhone(entry.to)}]`);
  if (entry.type === "template") {
    console.log(`${head} template ${entry.template?.name} (${entry.template?.languageCode}): ${entry.template?.bodyParams.join(" | ")}`);
    return;
  }
  console.log(`${head}\n${entry.body}`);
  if (entry.buttons?.length) console.log(styleText("gray", `  buttons: ${entry.buttons.map((b) => `[${b.title}]`).join(" ")}`));
}

async function main() {
  const cfg = loadConfig();
  const handle = await openDatabase({ databaseUrl: cfg.DATABASE_URL, dataDir: cfg.PGLITE_DIR });
  let llm: LlmClient | undefined;
  const engine = new ConversationEngine({
    db: handle.db,
    cfg,
    llm: () => (llm ??= createAnthropicLlm(cfg)),
    embedder: createEmbedder(),
    now: () => new Date(),
  });

  const worker = new InboundWorker({
    db: handle.db,
    cfg,
    engine,
    async apiFor(t, phoneNumberId) {
      const account = await findAccountByPhoneNumberId(handle.db, phoneNumberId);
      if (!account || account.coachId !== t.coachId) throw new WhatsAppConfigError(`No WhatsApp account ${phoneNumberId} for this coach`);
      return createApiForAccount(t, account, cfg, printDryRun);
    },
    transcriber: createTranscriber(cfg),
  });
  const scheduler = new ReminderScheduler({
    db: handle.db,
    cfg,
    async apiFor(t) {
      const account = await getCoachAccount(handle.db, t);
      return account ? createApiForAccount(t, account, cfg, printDryRun) : null;
    },
  });

  const server = buildServer({ db: handle.db, cfg });
  worker.start();
  scheduler.start();
  await server.listen({ port: cfg.PORT, host: "0.0.0.0" });

  console.log(styleText("bold", `FitCoach server: http://localhost:${cfg.PORT}  (webhook: /webhook)`));
  console.log(`DB: ${handle.kind === "pglite" ? `local PGlite (${cfg.PGLITE_DIR})` : "Postgres (DATABASE_URL)"}`);
  if (cfg.WHATSAPP_DRY_RUN) console.log(styleText("yellow", "WHATSAPP_DRY_RUN=true: outgoing messages are printed here, not sent to WhatsApp"));
  const missing = [
    !cfg.WHATSAPP_APP_SECRET && "WHATSAPP_APP_SECRET",
    !cfg.WHATSAPP_VERIFY_TOKEN && "WHATSAPP_VERIFY_TOKEN",
    !cfg.WHATSAPP_DRY_RUN && !cfg.WHATSAPP_ACCESS_TOKEN && "WHATSAPP_ACCESS_TOKEN",
    !cfg.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
  ].filter(Boolean);
  if (missing.length) console.log(styleText("yellow", `Missing in .env: ${missing.join(", ")}`));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await server.close();
    scheduler.stop();
    await worker.stop();
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(styleText("red", err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
