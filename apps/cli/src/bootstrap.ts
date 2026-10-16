import {
  ConversationEngine,
  createAnthropicLlm,
  createEmbedder,
  loadConfig,
  openDatabase,
  openTenantBySlug,
  type AppConfig,
  type DbHandle,
  type LlmClient,
  type TenantContext,
} from "@fitcoach/core";

export interface App {
  cfg: AppConfig;
  handle: DbHandle;
  engine: ConversationEngine;
  llm: () => LlmClient;
  tenant(slug: string): Promise<TenantContext>;
  close(): Promise<void>;
}

export async function bootstrap(): Promise<App> {
  const cfg = loadConfig();
  const handle = await openDatabase({ databaseUrl: cfg.DATABASE_URL, dataDir: cfg.PGLITE_DIR });
  let llm: LlmClient | undefined;
  const getLlm = () => (llm ??= createAnthropicLlm(cfg));
  const engine = new ConversationEngine({
    db: handle.db,
    cfg,
    llm: getLlm,
    embedder: createEmbedder(),
    now: () => new Date(),
  });
  return {
    cfg,
    handle,
    engine,
    llm: getLlm,
    tenant: (slug) => openTenantBySlug(handle.db, slug),
    close: () => handle.close(),
  };
}
