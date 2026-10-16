import Fastify, { LogController } from "fastify";
import { handleWebhookGet, handleWebhookPost, logger, type AppConfig, type Db } from "@fitcoach/core";

export interface ServerDeps {
  db: Db;
  cfg: AppConfig;
}

export function buildServer(deps: ServerDeps) {
  const { db, cfg } = deps;
  // Request logging stays off: webhook URLs carry the verify token and bodies carry health data.
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });

  // Keep the raw bytes: the signature is an HMAC over the exact body Meta sent.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  app.get("/webhook", async (req, reply) => {
    const res = handleWebhookGet(req.query as Record<string, unknown>, cfg);
    return reply.code(res.status).type("text/plain").send(res.body ?? "");
  });

  app.post("/webhook", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send();
    const signature = req.headers["x-hub-signature-256"];
    const res = await handleWebhookPost(db, cfg, req.body, typeof signature === "string" ? signature : undefined);
    return reply.code(res.status).send(res.body ?? "");
  });

  return app;
}
