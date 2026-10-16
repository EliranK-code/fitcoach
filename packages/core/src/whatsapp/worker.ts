import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { ConversationEngine, InboundMessage, UnsupportedKind } from "../engine/conversation";
import { logger } from "../logger";
import { clientPhone, getClient } from "../repos/clients";
import { createAlert } from "../repos/ops";
import { openTenant, type TenantContext } from "../tenancy";
import { ImageError, prepareImage } from "../media/images";
import type { Transcriber } from "../media/transcribe";
import { recordUsage } from "../repos/ops";
import { WhatsAppApiError, type WhatsAppApi } from "./api";
import {
  claimDueJobs,
  failJob,
  finishJob,
  listPendingInbound,
  markInbound,
  purgeProcessedInbound,
  type PendingInbound,
  type TurnJob,
} from "./inbox";
import { deliverTurn } from "./outbound";

export interface WorkerDeps {
  db: Db;
  cfg: AppConfig;
  engine: ConversationEngine;
  /** Resolves the sending API for a coach's number (real Graph API, or dry run). */
  apiFor(t: TenantContext, phoneNumberId: string): Promise<WhatsAppApi>;
  /** Voice-message transcription; without one, voice notes get a "please write" reply. */
  transcriber?: Transcriber | null;
  now?: () => Date;
  pollMs?: number;
  leaseMs?: number;
}

/** A unit the engine handles as one turn: consecutive texts merge; buttons and media stand alone. */
export interface InboundGroup {
  messages: PendingInbound[];
  input: Pick<InboundMessage, "text" | "buttonId" | "unsupported" | "externalId" | "image" | "voice">;
  /** A photo or voice note still to be downloaded (and transcribed) before the engine sees it. */
  media?: { kind: "image" | "audio"; mediaId: string };
}

const UNSUPPORTED: Record<string, UnsupportedKind> = {
  image: "image",
  audio: "audio",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  contacts: "contacts",
  unsupported: "other",
};

export function groupInbound(pending: PendingInbound[]): InboundGroup[] {
  const groups: InboundGroup[] = [];
  for (const m of pending) {
    const last = groups.at(-1);
    if (m.kind === "text" && last && last.messages.every((x) => x.kind === "text")) {
      last.messages.push(m);
      last.input.text = `${last.input.text}\n${m.text}`;
      last.input.externalId = undefined;
      continue;
    }
    if (m.kind === "text") groups.push({ messages: [m], input: { text: m.text, externalId: m.externalId } });
    else if (m.kind === "button") groups.push({ messages: [m], input: { text: m.text, buttonId: m.buttonId, externalId: m.externalId } });
    else if ((m.kind === "image" || m.kind === "audio") && m.mediaId) {
      groups.push({ messages: [m], input: { text: m.text, externalId: m.externalId }, media: { kind: m.kind, mediaId: m.mediaId } });
    } else groups.push({ messages: [m], input: { text: m.text, unsupported: UNSUPPORTED[m.kind] ?? "other", externalId: m.externalId } });
  }
  return groups;
}

/**
 * Polls turn_jobs and runs each client's pending messages through the conversation engine, then sends
 * the replies. One job per client at a time; different clients run in parallel up to WORKER_CONCURRENCY.
 */
export class InboundWorker {
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown>[] = [];
  private lastPurge = 0;
  private stopped = false;

  constructor(private readonly deps: WorkerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, "worker tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.deps.pollMs ?? 500);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled(this.running);
  }

  /** Claims whatever is due and starts processing it. Resolves once the claimed jobs finish. */
  async tick(): Promise<number> {
    const now = this.now();
    if (now.getTime() - this.lastPurge > 3600_000) {
      this.lastPurge = now.getTime();
      await purgeProcessedInbound(this.deps.db, new Date(now.getTime() - 7 * 24 * 3600_000));
    }
    const jobs = await claimDueJobs(this.deps.db, {
      now,
      limit: this.deps.cfg.WORKER_CONCURRENCY - this.active.size,
      leaseMs: this.deps.leaseMs ?? 5 * 60_000,
      exclude: this.active,
    });
    const runs = jobs.map((job) => {
      this.active.add(job.clientId);
      const run = this.process(job).finally(() => {
        this.active.delete(job.clientId);
        this.running = this.running.filter((r) => r !== run);
      });
      this.running.push(run);
      return run;
    });
    await Promise.allSettled(runs);
    return jobs.length;
  }

  /**
   * Downloads a photo (normalized for Claude) or a voice note (transcribed). Media that's gone or unreadable
   * becomes an "unsupported" message; network errors propagate so the job is retried.
   */
  private async resolveMedia(t: TenantContext, clientId: string, api: WhatsAppApi, group: InboundGroup): Promise<InboundGroup["input"]> {
    const { kind, mediaId } = group.media!;
    const unsupported: InboundGroup["input"] = { ...group.input, unsupported: kind };
    if (kind === "audio" && !this.deps.transcriber) return unsupported;
    let file: { data: Buffer; mimeType: string };
    try {
      file = await api.downloadMedia(mediaId);
    } catch (err) {
      if (err instanceof WhatsAppApiError && (err.status === 404 || err.status === 413)) return unsupported;
      throw err;
    }
    if (kind === "image") {
      try {
        return { ...group.input, image: await prepareImage(file.data) };
      } catch (err) {
        if (err instanceof ImageError) return unsupported;
        throw err;
      }
    }
    const transcriber = this.deps.transcriber!;
    const res = await transcriber.transcribe(file.data, file.mimeType);
    await recordUsage(this.deps.db, t, {
      clientId,
      kind: "transcription",
      model: transcriber.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });
    return res.text ? { ...group.input, text: res.text, voice: true } : unsupported;
  }

  private async process(job: TurnJob): Promise<void> {
    const { db, engine } = this.deps;
    try {
      const t = await openTenant(db, job.coachId);
      const client = await getClient(db, t, job.clientId);
      if (!client) return; // Deleted meanwhile; the job row went with it.
      const pending = await listPendingInbound(db, t, client.id);
      if (pending.length === 0) {
        await finishJob(db, client.id);
        return;
      }
      const api = await this.deps.apiFor(t, job.phoneNumberId);
      const phone = clientPhone(t, client);
      api.markRead(pending.at(-1)!.externalId, true).catch((err) => logger.warn({ err }, "markRead failed"));

      for (const group of groupInbound(pending)) {
        const input = group.media ? await this.resolveMedia(t, client.id, api, group) : group.input;
        const result = await engine.handleInbound({ coachId: t.coachId, phone, channel: "whatsapp", ...input });
        await markInbound(db, group.messages.map((m) => m.id), "done");
        if (result.clientId === null) {
          // The client asked to be deleted: their rows are gone, so confirm directly without logging.
          for (const r of result.replies) await api.sendText(phone, r);
          return;
        }
        const fresh = (await getClient(db, t, client.id)) ?? client;
        await deliverTurn(db, t, fresh, api, result, this.now());
      }
      await finishJob(db, client.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, clientId: job.clientId }, "turn job failed");
      const outcome = await failJob(db, job, message, this.now());
      if (outcome === "gave_up") {
        const t = await openTenant(db, job.coachId).catch(() => null);
        if (t && (await getClient(db, t, job.clientId))) {
          await createAlert(db, t, {
            clientId: job.clientId,
            type: "bot_error",
            severity: "high",
            source: "system",
            summary: `הודעות של הלקוח/ה לא טופלו אחרי כמה ניסיונות (${message.slice(0, 120)}). כדאי לענות ידנית.`,
          });
        }
      }
    }
  }
}
