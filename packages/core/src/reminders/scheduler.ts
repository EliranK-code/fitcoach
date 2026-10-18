import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { withTenant } from "../db/scope";
import { clients, coaches, type ReminderMessageKind } from "../db/schema";
import { splitForWhatsApp } from "../format/whatsapp";
import { logger } from "../logger";
import { clientPhone, getClient, getProfile, setClientFlags, type ClientRow } from "../repos/clients";
import { logChatMessage } from "../repos/conversation";
import { recordMessages } from "../repos/ops";
import { openTenant, type TenantContext } from "../tenancy";
import type { WhatsAppApi } from "../whatsapp/api";
import { sendTemplateMessage, serviceWindowOpen } from "../whatsapp/outbound";
import { fillReminderText, isQuietTime, localInfo, resolveReminderSettings } from "./schedule";
import { claimDueReminders } from "./store";

// Proactive messages, within WhatsApp's rules: inside the 24-hour window a free-form text, outside it only
// an approved template (none configured = skipped). Opt-outs, pauses, missing consent and removed access always win.
// What was sent is logged as unseen by the bot, so it sees the reminder as context on the next turn.

export type ReminderOutcome = "text" | "template" | "skipped";

export async function sendReminder(
  db: Db,
  t: TenantContext,
  client: ClientRow,
  kind: ReminderMessageKind,
  api: WhatsAppApi | null,
  now: Date,
): Promise<ReminderOutcome> {
  if (!api || client.channel !== "whatsapp" || client.isTest) return "skipped";
  if (client.consentStatus !== "granted" || !client.approvedAt || client.botPaused || client.flags.remindersOptOut) return "skipped";
  const settings = resolveReminderSettings(t.settings.reminders);
  const firstName = (await getProfile(db, t, client.id)).name?.split(/\s+/)[0] ?? null;

  if (serviceWindowOpen(client, now)) {
    const to = clientPhone(t, client);
    const parts = splitForWhatsApp(fillReminderText(settings.texts[kind], firstName));
    for (const part of parts) {
      const { messageId } = await api.sendText(to, part);
      await logChatMessage(db, t, {
        clientId: client.id,
        direction: "out",
        sender: "system",
        kind: "reminder",
        body: part,
        externalId: messageId ?? undefined,
        status: "sent",
        botSeen: false,
      });
    }
    await recordMessages(db, t, client.id, "message_out", parts.length);
    return "text";
  }

  const template = settings.templates[kind];
  if (!template?.name) return "skipped";
  await sendTemplateMessage(
    db,
    t,
    client,
    api,
    { name: template.name, languageCode: template.language || "he", bodyParams: [firstName ?? ""] },
    { actor: "scheduler", sender: "system" },
  );
  return "template";
}

export interface SchedulerDeps {
  db: Db;
  cfg: AppConfig;
  /** The coach's sending API, or null when no WhatsApp number is connected. */
  apiFor(t: TenantContext): Promise<WhatsAppApi | null>;
  now?: () => Date;
  pollMs?: number;
}

/** Inactivity check-ins go out only in daytime hours, once per quiet stretch. */
const CHECKIN_FROM = "10:00";
const CHECKIN_UNTIL = "19:00";

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastInactivityPass = 0;

  constructor(private readonly deps: SchedulerDeps) {}

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
        logger.error({ err }, "reminder tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.deps.pollMs ?? 60_000);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<{ sent: number; skipped: number }> {
    const { db, cfg } = this.deps;
    const now = this.now();
    const stats = { sent: 0, skipped: 0 };
    const tenants = new Map<string, TenantContext>();
    const tenant = async (id: string) => {
      let t = tenants.get(id);
      if (!t) tenants.set(id, (t = await openTenant(db, id)));
      return t;
    };

    for (const r of await claimDueReminders(db, cfg, now)) {
      try {
        const t = await tenant(r.coachId);
        const client = await getClient(db, t, r.clientId);
        const outcome = client ? await sendReminder(db, t, client, r.kind, await this.deps.apiFor(t), now) : "skipped";
        if (outcome === "skipped") stats.skipped++;
        else stats.sent++;
      } catch (err) {
        stats.skipped++;
        logger.error({ err, reminderId: r.id }, "reminder failed");
      }
    }

    if (now.getTime() - this.lastInactivityPass >= 30 * 60_000) {
      this.lastInactivityPass = now.getTime();
      const s = await this.inactivityPass(now, tenant);
      stats.sent += s.sent;
      stats.skipped += s.skipped;
    }
    return stats;
  }

  /** One gentle check-in after N days of silence (per coach setting); reset when the client writes again. */
  private async inactivityPass(now: Date, tenant: (id: string) => Promise<TenantContext>) {
    const { db, cfg } = this.deps;
    const stats = { sent: 0, skipped: 0 };
    const coachRows = await db.select({ id: coaches.id, settings: coaches.settings }).from(coaches).where(eq(coaches.status, "active"));
    for (const coach of coachRows) {
      const settings = resolveReminderSettings(coach.settings.reminders);
      if (settings.inactivityDays <= 0) continue;
      const tz = coach.settings.timezone ?? cfg.TIMEZONE;
      const { time } = localInfo(now, tz);
      if (time < CHECKIN_FROM || time >= CHECKIN_UNTIL || isQuietTime(now, tz, settings)) continue;

      const cutoff = new Date(now.getTime() - settings.inactivityDays * 24 * 3600_000);
      const quiet = await withTenant(db, { coachId: coach.id }, (db) =>
        db
          .select()
          .from(clients)
          .where(
            and(
              eq(clients.coachId, coach.id),
              eq(clients.channel, "whatsapp"),
              eq(clients.consentStatus, "granted"),
              isNotNull(clients.approvedAt),
              eq(clients.isTest, false),
              eq(clients.botPaused, false),
              isNotNull(clients.lastInboundAt),
              lt(clients.lastInboundAt, cutoff),
            ),
          ),
      );
      const t = await tenant(coach.id);
      const api = await this.deps.apiFor(t);
      for (const client of quiet) {
        if (client.flags.remindersOptOut) continue;
        const last = client.flags.lastCheckinAt ? Date.parse(client.flags.lastCheckinAt) : 0;
        if (last > client.lastInboundAt!.getTime()) continue; // Already nudged for this silence.
        try {
          const outcome = await sendReminder(db, t, client, "inactivity", api, now);
          // Record the attempt either way: without a template, retrying every 30 minutes is pointless.
          await setClientFlags(db, t, client, { lastCheckinAt: now.toISOString() });
          if (outcome === "skipped") stats.skipped++;
          else stats.sent++;
        } catch (err) {
          stats.skipped++;
          logger.error({ err, clientId: client.id }, "inactivity check-in failed");
        }
      }
    }
    return stats;
  }
}
