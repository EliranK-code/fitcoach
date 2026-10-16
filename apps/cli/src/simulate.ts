import { createHmac, randomBytes } from "node:crypto";
import { styleText } from "node:util";
import type { AppConfig } from "@fitcoach/core";

export interface SimulateOptions {
  phoneNumberId: string;
  from: string;
  text: string;
  buttonId?: string;
  type?: string;
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
    message = { ...base, type: opts.type, [opts.type]: { id: "sim-media", mime_type: "application/octet-stream", caption: opts.text || undefined } };
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
  if (!cfg.WHATSAPP_APP_SECRET) throw new Error("WHATSAPP_APP_SECRET חסר ב-.env (כל מחרוזת מתאימה לבדיקה מקומית)");
  if (!opts.text && !opts.buttonId && !opts.type) throw new Error('חסר טקסט: npm run wa:simulate -- "היי"');
  const body = JSON.stringify(buildWebhookPayload(opts));
  const signature = `sha256=${createHmac("sha256", cfg.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
  const url = `http://localhost:${cfg.PORT}/webhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body,
  }).catch((err: unknown) => {
    throw new Error(`השרת לא זמין ב-${url} (הריצו npm run server). ${err instanceof Error ? err.message : ""}`);
  });
  const ok = res.status === 200;
  console.log(styleText(ok ? "green" : "red", `${res.status} ${ok ? "נשלח לשרת. התשובה תודפס בחלון של השרת אחרי כמה שניות." : await res.text()}`));
}
