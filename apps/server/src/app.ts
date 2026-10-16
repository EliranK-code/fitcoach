import Fastify, { LogController } from "fastify";
import {
  applyStatuses,
  enqueueInbound,
  logger,
  parseWebhook,
  verifySignature,
  verifySubscription,
  type AppConfig,
  type Db,
} from "@fitcoach/core";

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

  // Meta's one-time handshake when the webhook URL is registered.
  app.get("/webhook", async (req, reply) => {
    const challenge = verifySubscription(req.query as Record<string, unknown>, cfg.WHATSAPP_VERIFY_TOKEN);
    if (challenge === null) return reply.code(403).send("forbidden");
    return reply.type("text/plain").send(challenge);
  });

  app.post("/webhook", async (req, reply) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return reply.code(415).send();
    if (!cfg.WHATSAPP_APP_SECRET) {
      logger.error("WHATSAPP_APP_SECRET is not set: rejecting webhook (fail closed)");
      return reply.code(500).send();
    }
    const signature = req.headers["x-hub-signature-256"];
    if (!verifySignature(raw, typeof signature === "string" ? signature : undefined, cfg.WHATSAPP_APP_SECRET)) {
      logger.warn("webhook with an invalid signature");
      return reply.code(401).send();
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply.code(400).send();
    }
    const { messages, statuses } = parseWebhook(body);
    // Store first, answer after: if this throws, Meta gets a 500 and redelivers later.
    await enqueueInbound(db, messages, { debounceMs: cfg.INBOUND_DEBOUNCE_MS });
    await applyStatuses(db, statuses);
    return reply.code(200).send();
  });

  return app;
}
