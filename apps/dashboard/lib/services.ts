import {
  ConversationEngine,
  createAnthropicLlm,
  createApiForAccount,
  createEmbedder,
  findAccountByPhoneNumberId,
  InboundWorker,
  loadConfig,
  logger,
  openDatabase,
  WhatsAppConfigError,
  type AppConfig,
  type DbHandle,
  type Embedder,
  type LlmClient,
  type TenantContext,
  type WhatsAppApi,
} from "@fitcoach/core";

// One database connection, engine and worker per server process. Next.js re-evaluates modules on hot
// reload, so the instance lives on globalThis: opening the local PGlite directory twice would corrupt it.

export interface Services {
  cfg: AppConfig;
  handle: DbHandle;
  engine: ConversationEngine;
  embedder: Embedder | null;
  llm(): LlmClient;
  whatsappApi(t: TenantContext, phoneNumberId: string): Promise<WhatsAppApi>;
  worker: InboundWorker | null;
}

const store = globalThis as unknown as { __fitcoachServices?: Promise<Services> };

async function init(): Promise<Services> {
  const cfg = loadConfig();
  const handle = await openDatabase({ databaseUrl: cfg.DATABASE_URL, dataDir: cfg.PGLITE_DIR });
  let llm: LlmClient | undefined;
  const getLlm = () => (llm ??= createAnthropicLlm(cfg));
  const embedder = createEmbedder();
  const engine = new ConversationEngine({ db: handle.db, cfg, llm: getLlm, embedder, now: () => new Date() });

  const whatsappApi = async (t: TenantContext, phoneNumberId: string) => {
    const account = await findAccountByPhoneNumberId(handle.db, phoneNumberId);
    if (!account || account.coachId !== t.coachId) throw new WhatsAppConfigError(`No WhatsApp account ${phoneNumberId} for this coach`);
    return createApiForAccount(t, account, cfg, (e) => logger.info({ dryRun: e.type, to: e.to }, "WhatsApp dry run"));
  };

  // The dashboard process also runs the WhatsApp worker, so one process serves everything (and the
  // single-process local database works). Set DASHBOARD_RUN_WORKER=false when a separate server runs it.
  const worker = process.env.DASHBOARD_RUN_WORKER === "false" ? null : new InboundWorker({ db: handle.db, cfg, engine, apiFor: whatsappApi });
  worker?.start();

  return { cfg, handle, engine, embedder, llm: getLlm, whatsappApi, worker };
}

export function services(): Promise<Services> {
  store.__fitcoachServices ??= init().catch((err) => {
    store.__fitcoachServices = undefined;
    throw err;
  });
  return store.__fitcoachServices;
}
