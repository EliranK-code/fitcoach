import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationEpochs, llmMessages, reminders } from "../src/db/schema";
import { PLATFORM_HASH } from "../src/engine/epochs";
import { ImageError, prepareImage } from "../src/media/images";
import { findClientByPhone, getClient, setClientFlags, updateClient } from "../src/repos/clients";
import { getActiveEpoch, listChatMessages } from "../src/repos/conversation";
import { listAlerts } from "../src/repos/ops";
import { fillReminderText, isQuietTime, nextOccurrence, resolveReminderSettings, zonedTimeToUtc } from "../src/reminders/schedule";
import { ReminderScheduler } from "../src/reminders/scheduler";
import { listClientReminders, setClientReminders } from "../src/reminders/store";
import { updateCoach, type TenantContext } from "../src/tenancy";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { createDryRunApi, createGraphApi } from "../src/whatsapp/api";
import { enqueueInbound } from "../src/whatsapp/inbox";
import { InboundWorker } from "../src/whatsapp/worker";
import { consentedClient, createTestApp, message, openToEveryone, text, toolUse, type TestApp } from "./helpers";

const TZ = "Asia/Jerusalem";
const QUIET = resolveReminderSettings(undefined);

describe("reminder time math", () => {
  it("converts local Israel time to UTC across daylight saving", () => {
    expect(zonedTimeToUtc("2026-07-01", "08:00", TZ).toISOString()).toBe("2026-07-01T05:00:00.000Z"); // IDT, UTC+3
    expect(zonedTimeToUtc("2026-12-01", "08:00", TZ).toISOString()).toBe("2026-12-01T06:00:00.000Z"); // IST, UTC+2
  });

  it("finds the next allowed day and time", () => {
    // Thursday 2026-10-15 10:00 local; rule: Sundays and Wednesdays at 07:30 → quiet until 08:00, so 08:30 instead.
    const after = zonedTimeToUtc("2026-10-15", "10:00", TZ);
    const next = nextOccurrence({ days: [0, 3], time: "08:30" }, after, TZ, QUIET)!;
    expect(next.toISOString()).toBe(zonedTimeToUtc("2026-10-18", "08:30", TZ).toISOString()); // Sunday
  });

  it("skips quiet hours and Shabbat", () => {
    expect(isQuietTime(zonedTimeToUtc("2026-10-15", "22:00", TZ), TZ, QUIET)).toBe(true);
    expect(isQuietTime(zonedTimeToUtc("2026-10-15", "07:00", TZ), TZ, QUIET)).toBe(true);
    expect(isQuietTime(zonedTimeToUtc("2026-10-16", "16:00", TZ), TZ, QUIET)).toBe(true); // Friday afternoon
    expect(isQuietTime(zonedTimeToUtc("2026-10-17", "10:00", TZ), TZ, QUIET)).toBe(true); // Saturday
    expect(isQuietTime(zonedTimeToUtc("2026-10-17", "10:00", TZ), TZ, { ...QUIET, skipShabbat: false })).toBe(false);
    // A Saturday-only weigh-in never fires while Shabbat is respected.
    const after = zonedTimeToUtc("2026-10-15", "10:00", TZ);
    expect(nextOccurrence({ days: [6], time: "09:00" }, after, TZ, QUIET)).toBeNull();
  });

  it("fills the client's first name", () => {
    expect(fillReminderText("בוקר טוב {name}! ⚖️", "דנה")).toBe("בוקר טוב דנה! ⚖️");
    expect(fillReminderText("בוקר טוב {name}! ⚖️", null)).toBe("בוקר טוב! ⚖️");
  });
});

describe("photos", () => {
  it("scales down, re-encodes as JPEG and strips metadata", async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 120, b: 60 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "secret-location" } } })
      .toBuffer();
    const img = await prepareImage(big);
    expect(img.mediaType).toBe("image/jpeg");
    expect(Math.max(img.width, img.height)).toBe(1568);
    const meta = await sharp(Buffer.from(img.data, "base64")).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("rejects data that isn't an image", async () => {
    await expect(prepareImage(Buffer.from("definitely not a photo"))).rejects.toBeInstanceOf(ImageError);
  });
});

describe("Graph API media download", () => {
  it("looks up the media URL, then downloads it with the token", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      if (url.includes("graph.facebook.com")) return Response.json({ url: "https://lookaside.example/abc", mime_type: "audio/ogg", file_size: 3 });
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const api = createGraphApi({ token: "T", phoneNumberId: "1", version: "v23.0", fetch: fakeFetch });
    const file = await api.downloadMedia("MEDIA123");
    expect(file).toEqual({ data: Buffer.from([1, 2, 3]), mimeType: "audio/ogg" });
    expect(calls).toEqual(["https://graph.facebook.com/v23.0/MEDIA123 Bearer T", "https://lookaside.example/abc Bearer T"]);
  });

  it("refuses path tricks in simulated media ids", async () => {
    const api = createDryRunApi("pn", () => {});
    await expect(api.downloadMedia("../../.env")).rejects.toThrow();
    await expect(api.downloadMedia(".env")).rejects.toThrow();
  });
});

describe("engine: photos, voice, STOP, platform changes", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app?.handle.close();
  });
  const send = (input: Partial<Parameters<TestApp["engine"]["handleInbound"]>[0]>) =>
    app.engine.handleInbound({ coachId: app.coachId, phone: "0501234567", text: "", channel: "cli", ...input });

  it("sends a photo to Claude as base64 with its caption, and logs only a label", async () => {
    await consentedClient(app);
    const image = await prepareImage(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ffffff" } }).png().toBuffer());
    app.llm.push(message([text("נראה מצוין! הרבה ירקות 👏")]));
    await send({ text: "ארוחת צהריים", image });
    const user = app.llm.chatRequests.at(-1)!.messages.findLast((m) => m.role === "user") as { content: { type: string; source?: { type: string; data: string }; text?: string }[] };
    expect(user.content[0]).toMatchObject({ type: "image", source: { type: "base64", data: image.data } });
    expect(user.content[1]!.text).toContain("[Photo, with the caption:] ארוחת צהריים");
    const t = await app.tenant();
    const log = await listChatMessages(app.handle.db, t, (await findClientByPhone(app.handle.db, t, "0501234567"))!.id);
    expect(log.find((m) => m.kind === "image")?.body).toBe("[photo] ארוחת צהריים");
  });

  it("marks voice transcripts and runs red-flag detection on them", async () => {
    await consentedClient(app);
    app.llm.push(message([text("עצור ופנה לרופא")]));
    await send({ text: "יש לי כאב בחזה כשאני רץ", voice: true });
    const user = app.llm.chatRequests.at(-1)!.messages.findLast((m) => m.role === "user") as { content: { text: string }[] };
    expect(user.content[0]!.text).toContain("[Voice message, automatic transcription] יש לי כאב בחזה");
    const alerts = await listAlerts(app.handle.db, await app.tenant(), { status: "open" });
    expect(alerts.some((a) => a.type === "medical")).toBe(true);
  });

  it("answers a voice note without a transcriber with a fixed reply", async () => {
    await consentedClient(app);
    const before = app.llm.requests.length;
    const res = await send({ unsupported: "audio" });
    expect(res.replies[0]).toContain("voice messages");
    expect(app.llm.requests.length).toBe(before);
  });

  it("STOP turns off proactive messages without the AI", async () => {
    await consentedClient(app);
    const t = await app.tenant();
    const client = (await findClientByPhone(app.handle.db, t, "0501234567"))!;
    await setClientReminders(app.handle.db, t, app.cfg, client.id, [{ kind: "weigh_in", days: [0], time: "09:00" }], app.clock.now);
    const before = app.llm.requests.length;
    const res = await send({ text: "STOP" });
    expect(res.replies[0]).toContain("won't send");
    expect(app.llm.requests.length).toBe(before);
    expect((await getClient(app.handle.db, t, client.id))!.flags.remindersOptOut).toBe(true);
    expect((await listClientReminders(app.handle.db, t, client.id)).every((r) => !r.enabled)).toBe(true);
  });

  it("saves reminders through the set_reminder_preferences tool", async () => {
    await consentedClient(app);
    app.llm.push(
      message([toolUse("set_reminder_preferences", { opt_out_all: false, reminders: [{ kind: "weigh_in", days: [0, 3], time: "08:30" }, { kind: "workout", days: [9], time: "25:00" }] })]),
      message([text("מעולה, אזכיר לך!")]),
    );
    await send({ text: "כן, תזכיר לי לשקול בראשון ורביעי ב-8:30" });
    const t = await app.tenant();
    const client = (await findClientByPhone(app.handle.db, t, "0501234567"))!;
    const rows = await listClientReminders(app.handle.db, t, client.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "weigh_in", days: [0, 3], time: "08:30", enabled: true });
    expect(rows[0]!.nextRunAt).toBeInstanceOf(Date);
    expect(JSON.stringify(app.llm.chatRequests.at(-1)!.messages.at(-1))).toContain("Rejected: workout");
  });

  it("rolls conversations over when the platform rules or tools change, and drops the closed history", async () => {
    await consentedClient(app);
    const t = await app.tenant();
    const client = (await findClientByPhone(app.handle.db, t, "0501234567"))!;
    const epoch = (await getActiveEpoch(app.handle.db, t, client.id))!;
    expect(epoch.row.platformHash).toBe(PLATFORM_HASH);
    // Simulate an epoch frozen by an older deploy.
    const { eq } = await import("drizzle-orm");
    await app.handle.db.update(conversationEpochs).set({ platformHash: "old" }).where(eq(conversationEpochs.id, epoch.row.id));
    app.llm.push(message([text("היי שוב")]));
    const res = await send({ text: "היי" });
    expect(res.events.some((e) => e.type === "epoch" && e.reason === "platform_updated")).toBe(true);
    expect(await app.handle.db.select().from(llmMessages).where(eq(llmMessages.epochId, epoch.row.id))).toHaveLength(0);
  });
});

describe("reminder scheduler", () => {
  let app: TestApp;
  let t: TenantContext;
  let api: ReturnType<typeof createDryRunApi>;
  let scheduler: ReminderScheduler;
  const PHONE = "972501112222";

  beforeEach(async () => {
    app = await createTestApp();
    t = await app.tenant();
    await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: "pn-r" });
    api = createDryRunApi("pn-r", () => {});
    scheduler = new ReminderScheduler({ db: app.handle.db, cfg: app.cfg, apiFor: async () => api, now: () => app.clock.now });
    // A consented WhatsApp client, as the webhook would create it.
    app.clock.now = zonedTimeToUtc("2026-10-18", "07:00", TZ); // Sunday morning
    await app.engine.handleInbound({ coachId: app.coachId, phone: PHONE, text: "היי", channel: "whatsapp" });
    app.llm.push(message([text("היי! איך קוראים לך?")]));
    await app.engine.handleInbound({ coachId: app.coachId, phone: PHONE, text: "מאשר", channel: "whatsapp" });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  const client = async () => (await findClientByPhone(app.handle.db, t, PHONE))!;

  it("sends a due reminder as free text inside the 24-hour window, once", async () => {
    await setClientReminders(app.handle.db, t, app.cfg, (await client()).id, [{ kind: "weigh_in", days: [0], time: "08:30" }], app.clock.now);
    app.clock.now = zonedTimeToUtc("2026-10-18", "08:31", TZ);
    expect(await scheduler.tick()).toMatchObject({ sent: 1 });
    expect(api.sent.at(-1)).toMatchObject({ type: "text", to: PHONE });
    expect(api.sent.at(-1)!.body).toContain("weigh in");
    expect(await scheduler.tick()).toMatchObject({ sent: 0 }); // moved to next week
    const [row] = await app.handle.db.select().from(reminders);
    expect(row!.nextRunAt!.toISOString()).toBe(zonedTimeToUtc("2026-10-25", "08:30", TZ).toISOString());

    // The bot sees the reminder as context on the client's next message.
    const log = await listChatMessages(app.handle.db, t, (await client()).id);
    expect(log.at(-1)).toMatchObject({ sender: "system", kind: "reminder" });
    app.llm.push(message([text("רשמתי!")]));
    await app.engine.handleInbound({ coachId: app.coachId, phone: PHONE, text: "66.5", channel: "whatsapp" });
    expect(String(app.llm.chatRequests.at(-1)!.messages.at(-1)!.content)).toContain("Automatic reminder");
  });

  it("outside the window uses an approved template, or skips without one", async () => {
    await setClientReminders(app.handle.db, t, app.cfg, (await client()).id, [{ kind: "weigh_in", days: [0], time: "08:30" }], app.clock.now);
    app.clock.now = zonedTimeToUtc("2026-10-25", "08:31", TZ); // a week later, window closed
    expect(await scheduler.tick()).toMatchObject({ sent: 0, skipped: 1 });

    t = await updateCoach(app.handle.db, t, { settings: { reminders: { templates: { weigh_in: { name: "weigh_in_reminder", language: "he" } } } } });
    app.clock.now = zonedTimeToUtc("2026-11-01", "08:31", TZ);
    expect(await scheduler.tick()).toMatchObject({ sent: 1 });
    expect(api.sent.at(-1)).toMatchObject({ type: "template", template: { name: "weigh_in_reminder", languageCode: "he" } });
  });

  it("never messages clients who opted out or are paused", async () => {
    await setClientReminders(app.handle.db, t, app.cfg, (await client()).id, [{ kind: "weigh_in", days: [0], time: "08:30" }], app.clock.now);
    await setClientFlags(app.handle.db, t, await client(), { remindersOptOut: true });
    app.clock.now = zonedTimeToUtc("2026-10-18", "08:31", TZ);
    expect(await scheduler.tick()).toMatchObject({ sent: 0 });
    await setClientFlags(app.handle.db, t, await client(), { remindersOptOut: undefined });
    await updateClient(app.handle.db, t, (await client()).id, { botPaused: true });
    app.clock.now = zonedTimeToUtc("2026-10-25", "08:31", TZ);
    expect(await scheduler.tick()).toMatchObject({ sent: 0 });
  });

  it("sends one inactivity check-in per quiet stretch, in daytime, via template", async () => {
    t = await updateCoach(app.handle.db, t, { settings: { reminders: { inactivityDays: 4, templates: { inactivity: { name: "checkin", language: "he" } } } } });
    app.clock.now = zonedTimeToUtc("2026-10-23", "11:00", TZ); // Friday morning, 5 days later
    expect(await scheduler.tick()).toMatchObject({ sent: 1 });
    expect(api.sent.at(-1)).toMatchObject({ type: "template", template: { name: "checkin" } });
    app.clock.now = new Date(app.clock.now.getTime() + 3600_000);
    expect((await scheduler.tick()).sent).toBe(0); // not again for the same silence
  });
});

describe("worker media handling", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp({ INBOUND_DEBOUNCE_MS: "0" });
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  it("downloads photos and transcribes voice notes before the engine sees them", async () => {
    const t = await openToEveryone(app.handle.db, await app.tenant());
    await connectWhatsAppNumber(app.handle.db, t, { phoneNumberId: "pn-m" });
    const api = createDryRunApi("pn-m", () => {});
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#cccccc" } }).jpeg().toBuffer();
    api.downloadMedia = async (id) => (id === "img1" ? { data: photo, mimeType: "image/jpeg" } : { data: Buffer.from("ogg"), mimeType: "audio/ogg" });
    const transcriber = { model: "fake", transcribe: async () => ({ text: "שקלתי היום 70", inputTokens: 1, outputTokens: 1 }) };
    const worker = new InboundWorker({ db: app.handle.db, cfg: app.cfg, engine: app.engine, apiFor: async () => api, transcriber, now: () => app.clock.now });
    const from = "972503334444";
    let n = 0;
    const receive = async (m: Record<string, unknown>) => {
      await enqueueInbound(app.handle.db, [{ phoneNumberId: "pn-m", from, id: `w${++n}`, timestamp: app.clock.now, kind: "text", text: "", ...m } as never], { debounceMs: 0, now: app.clock.now });
      app.clock.now = new Date(app.clock.now.getTime() + 1000);
      await worker.tick();
    };
    await receive({ text: "היי" });
    app.llm.push(message([text("היי!")]));
    await receive({ kind: "button", buttonId: "consent_yes", text: "מאשר/ת" });

    app.llm.push(message([text("ארוחה יפה")]));
    await receive({ kind: "image", mediaId: "img1", text: "צהריים" });
    const imgReq = app.llm.chatRequests.at(-1)!.messages.findLast((m) => m.role === "user") as { content: { type: string }[] };
    expect(imgReq.content[0]!.type).toBe("image");

    app.llm.push(message([text("רשמתי")]));
    await receive({ kind: "audio", mediaId: "aud1" });
    const voiceReq = app.llm.chatRequests.at(-1)!.messages.findLast((m) => m.role === "user") as { content: { text: string }[] };
    expect(voiceReq.content[0]!.text).toContain("[Voice message, automatic transcription] שקלתי היום 70");
  });
});
