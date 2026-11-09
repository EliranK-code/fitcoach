import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { styleText } from "node:util";
import { simulatedMediaDir, type AppConfig } from "@fitcoach/core";

export interface SimulateOptions {
  phoneNumberId: string;
  from: string;
  text: string;
  buttonId?: string;
  type?: string;
  /** A local photo or voice file; copied where the dry-run API can "download" it. */
  file?: string;
  mediaId?: string;
}

/** Builds a webhook payload shaped like Meta's for one inbound message. */
export function buildWebhookPayload(opts: SimulateOptions, now = new Date()) {
  const base = {
    from: opts.from,
    id: `wamid.sim.${now.getTime()}.${randomBytes(4).toString("hex")}`,
    timestamp: String(Math.floor(now.getTime() / 1000)),
  };
  let message: Record<string, unknown>;
  if (opts.buttonId) {
    message = { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: opts.buttonId, title: opts.text || opts.buttonId } } };
  } else if (opts.type && opts.type !== "text") {
    message = { ...base, type: opts.type, [opts.type]: { id: opts.mediaId ?? "sim-media", mime_type: "application/octet-stream", caption: opts.text || undefined } };
  } else {
    message = { ...base, type: "text", text: { body: opts.text } };
  }
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "0000", phone_number_id: opts.phoneNumberId },
              contacts: [{ profile: { name: "Simulated client" }, wa_id: opts.from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** Sends a signed fake webhook to the local server: tests the whole pipeline without Meta. */
export async function simulateWebhook(cfg: AppConfig, opts: SimulateOptions): Promise<void> {
  if (!cfg.WHATSAPP_APP_SECRET) throw new Error("WHATSAPP_APP_SECRET is missing in .env (any string works for local testing)");
  if (opts.file) {
    const src = resolve(opts.file);
    if (!existsSync(src)) throw new Error(`File not found: ${opts.file}`);
    const ext = extname(src).toLowerCase();
    const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
    if (!isImage && ![".ogg", ".opus", ".mp3", ".m4a", ".wav"].includes(ext)) throw new Error("Supported: jpg, png, webp, ogg, mp3, m4a, wav");
    mkdirSync(simulatedMediaDir(), { recursive: true });
    const mediaId = `sim-${randomBytes(6).toString("hex")}${ext}`;
    copyFileSync(src, join(simulatedMediaDir(), mediaId));
    opts = { ...opts, type: isImage ? "image" : "audio", mediaId };
  }
  if (!opts.text && !opts.buttonId && !opts.type) throw new Error('Missing text: npm run wa:simulate -- "hi"');
  const body = JSON.stringify(buildWebhookPayload(opts));
  const signature = `sha256=${createHmac("sha256", cfg.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
  const url = `http://localhost:${cfg.PORT}/webhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body,
  }).catch((err: unknown) => {
    throw new Error(`The server isn't available at ${url} (run npm run server). ${err instanceof Error ? err.message : ""}`);
  });
  const ok = res.status === 200;
  console.log(styleText(ok ? "green" : "red", `${res.status} ${ok ? "Sent to the server. The reply will print in the server window in a few seconds." : await res.text()}`));
}
