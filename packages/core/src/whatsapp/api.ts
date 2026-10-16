import { logger } from "../logger";

// Thin client for the official WhatsApp Business Cloud API (Graph API). No unofficial libraries:
// those automate the consumer app and get numbers banned.

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface SendResult {
  /** The wamid WhatsApp assigned; status webhooks refer to it. null in dry-run mode. */
  messageId: string | null;
}

export interface WhatsAppApi {
  readonly phoneNumberId: string;
  sendText(to: string, body: string): Promise<SendResult>;
  /** Up to 3 reply buttons (title ≤ 20 chars) under a body of ≤ 1024 chars. */
  sendButtons(to: string, body: string, buttons: WhatsAppButton[]): Promise<SendResult>;
  /** Approved template: the only way to message a client outside the 24-hour customer service window. */
  sendTemplate(to: string, name: string, languageCode: string, bodyParams: string[]): Promise<SendResult>;
  /** Blue ticks on the client's message, optionally with a "typing…" indicator until we reply. */
  markRead(messageId: string, typing: boolean): Promise<void>;
}

export const BUTTON_BODY_MAX = 1024;
export const BUTTON_TITLE_MAX = 20;

/** Meta error codes we handle explicitly. */
export const WA_ERRORS = {
  /** More than 24 hours since the client's last message: only templates are allowed. */
  REENGAGEMENT: 131047,
  /** Rate limit / spam rate limit hit. */
  RATE_LIMIT: 131056,
} as const;

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly details?: string,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

type FetchLike = typeof fetch;

export interface GraphApiOptions {
  token: string;
  phoneNumberId: string;
  version: string;
  fetch?: FetchLike;
  retries?: number;
}

export function createGraphApi(opts: GraphApiOptions): WhatsAppApi {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://graph.facebook.com/${opts.version}/${opts.phoneNumberId}/messages`;
  const retries = opts.retries ?? 2;

  async function post(body: Record<string, unknown>): Promise<{ messages?: { id: string }[] }> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };
      if (res.ok) return json;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new WhatsAppApiError(
        json.error?.message ?? `WhatsApp API HTTP ${res.status}`,
        res.status,
        json.error?.code ?? null,
        json.error?.error_data?.details,
      );
    }
  }

  const messageId = (json: { messages?: { id: string }[] }) => ({ messageId: json.messages?.[0]?.id ?? null });

  return {
    phoneNumberId: opts.phoneNumberId,
    async sendText(to, body) {
      return messageId(await post({ recipient_type: "individual", to, type: "text", text: { body, preview_url: false } }));
    },
    async sendButtons(to, body, buttons) {
      return messageId(
        await post({
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: body.slice(0, BUTTON_BODY_MAX) },
            action: {
              buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, BUTTON_TITLE_MAX) } })),
            },
          },
        }),
      );
    },
    async sendTemplate(to, name, languageCode, bodyParams) {
      return messageId(
        await post({
          recipient_type: "individual",
          to,
          type: "template",
          template: {
            name,
            language: { code: languageCode },
            ...(bodyParams.length
              ? { components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }] }
              : {}),
          },
        }),
      );
    },
    async markRead(id, typing) {
      await post({ status: "read", message_id: id, ...(typing ? { typing_indicator: { type: "text" } } : {}) });
    },
  };
}

export interface DryRunEntry {
  phoneNumberId: string;
  to?: string;
  type: "text" | "buttons" | "template" | "read";
  body?: string;
  buttons?: WhatsAppButton[];
  template?: { name: string; languageCode: string; bodyParams: string[] };
}

/** Records instead of sending (WHATSAPP_DRY_RUN=true, and tests). */
export function createDryRunApi(
  phoneNumberId: string,
  sink: (entry: DryRunEntry) => void = (e) => logger.info({ dryRun: e.type, to: e.to }, "WhatsApp dry run"),
): WhatsAppApi & { sent: DryRunEntry[] } {
  const sent: DryRunEntry[] = [];
  let n = 0;
  const record = (entry: DryRunEntry) => {
    sent.push(entry);
    sink(entry);
    return { messageId: `dryrun.${phoneNumberId}.${++n}` };
  };
  return {
    phoneNumberId,
    sent,
    async sendText(to, body) {
      return record({ phoneNumberId, to, type: "text", body });
    },
    async sendButtons(to, body, buttons) {
      return record({ phoneNumberId, to, type: "buttons", body, buttons });
    },
    async sendTemplate(to, name, languageCode, bodyParams) {
      return record({ phoneNumberId, to, type: "template", template: { name, languageCode, bodyParams } });
    },
    async markRead(id) {
      record({ phoneNumberId, type: "read", body: id });
    },
  };
}
