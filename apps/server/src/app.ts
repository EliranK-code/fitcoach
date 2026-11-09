import { STATUS_CODES } from "node:http";
import Fastify, { LogController } from "fastify";
import { handleWebhookGet, handleWebhookPost, logger, WEBHOOK_MAX_BYTES, type AppConfig, type Db } from "@fitcoach/core";

export interface ServerDeps {
  db: Db;
  cfg: AppConfig;
  /** Tests pass their own to read what gets logged. */
  logger?: typeof logger;
}

export function buildServer(deps: ServerDeps) {
  const { db, cfg } = deps;
  // Request logging stays off: webhook URLs carry the verify token and bodies carry health data.
  const app = Fastify({
    loggerInstance: deps.logger ?? logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: WEBHOOK_MAX_BYTES,
  });

  // An error's message can hold SQL, query parameters or file paths, so the client only gets the status
  // text. The log gets the error (redacted by the logger) and the route, never the URL: GET /webhook
  // carries the verify token in its query string.
  app.setErrorHandler((err, req, reply) => {
    const { statusCode, code } = (err ?? {}) as { statusCode?: unknown; code?: unknown };
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const where = { method: req.method, route: req.routeOptions.url ?? null };
    if (status >= 500) req.log.error({ err, ...where }, "request failed");
    else req.log.info({ code: typeof code === "string" ? code : null, status, ...where }, "request rejected");
    return reply.code(status).type("application/json").send({ error: STATUS_CODES[status] ?? "Error" });
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
