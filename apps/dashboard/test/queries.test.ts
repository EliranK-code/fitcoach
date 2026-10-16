import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert, createCoach, findOrCreateClient, openTenant, saveProfile, updateClient, type TenantContext } from "@fitcoach/core";
import { createTestApp, type TestApp } from "../../../packages/core/test/helpers";
import { clientDetail, clientRows, overviewStats } from "../lib/queries";

let app: TestApp;
let t: TenantContext;
let other: TenantContext;

beforeAll(async () => {
  app = await createTestApp();
  t = await app.tenant();
  other = await openTenant(app.handle.db, await createCoach(app.handle.db, { slug: "other", name: "מאמנת אחרת" }));
  const db = app.handle.db;

  const { client: dana } = await findOrCreateClient(db, t, { phone: "0501111111", channel: "whatsapp" });
  await saveProfile(db, t, dana.id, { name: "דנה", goal: "fat_loss" });
  await updateClient(db, t, dana.id, { lastInboundAt: new Date(), consentStatus: "granted" });
  await createAlert(db, t, { clientId: dana.id, type: "medical", severity: "urgent", source: "detector", summary: "כאב בחזה" });

  // Playground test clients stay out of lists and stats.
  await findOrCreateClient(db, t, { phone: "playground:user", channel: "playground", isTest: true });
  // Another coach's client must never show up.
  await findOrCreateClient(db, other, { phone: "0502222222", channel: "whatsapp" });
});

afterAll(async () => {
  await app.handle.close();
});

describe("dashboard queries", () => {
  it("counts only this coach's real clients", async () => {
    const stats = await overviewStats(app.handle.db, t);
    expect(stats).toMatchObject({ clients: 1, activeClients: 1, openAlerts: 1, urgentAlerts: 1 });
  });

  it("lists clients with names, alerts and no test clients", async () => {
    const rows = await clientRows(app.handle.db, t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "דנה", openAlerts: 1, goal: "fat_loss", channel: "whatsapp" });
  });

  it("refuses a client id from another coach", async () => {
    const [mine] = await clientRows(app.handle.db, t);
    await expect(clientDetail(app.handle.db, other, mine!.id)).rejects.toThrow();
    const detail = await clientDetail(app.handle.db, t, mine!.id);
    expect(detail.profile.name).toBe("דנה");
    expect(detail.canSendWhatsApp).toBe(false); // no number connected yet
    expect(detail.windowOpen).toBe(true);
  });
});
