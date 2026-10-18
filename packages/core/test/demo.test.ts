import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { coaches, platformAudit } from "../src/db/schema";
import { listCoaches, listDemoCoaches, removeDemoCoaches } from "../src/platform";
import { findOrCreateClient } from "../src/repos/clients";
import { createCoach, openTenant, updateCoach } from "../src/tenancy";
import { createTestApp, type TestApp } from "./helpers";

// The seed's demo coach is marked so it can be removed in one step before real coaches join.

describe("demo coach removal", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app?.handle.close();
  });

  it("deletes only coaches marked as demo, with their clients, and keeps the usage summary", async () => {
    const db = app.handle.db;
    const demo = await updateCoach(db, await app.tenant(), { settings: { demo: true } });
    await findOrCreateClient(db, demo, { phone: "0501111111", channel: "whatsapp" });
    const real = await openTenant(db, await createCoach(db, { slug: "real-coach", name: "מאמנת אמיתית" }));

    expect((await listDemoCoaches(db)).map((c) => c.slug)).toEqual(["demo"]);
    expect((await listCoaches(db)).map((c) => [c.slug, c.demo])).toEqual([
      ["demo", true],
      ["real-coach", false],
    ]);

    const removed = await removeDemoCoaches(db, "cli");
    expect(removed).toMatchObject([{ slug: "demo", clients: 1 }]);
    expect((await db.select({ slug: coaches.slug }).from(coaches)).map((c) => c.slug)).toEqual(["real-coach"]);
    expect(await db.select().from(platformAudit).where(eq(platformAudit.action, "coach_deleted"))).toHaveLength(1);
    expect((await openTenant(db, real.coachId)).status).toBe("active");

    // Nothing left to remove: a second run is a no-op.
    expect(await removeDemoCoaches(db, "cli")).toEqual([]);
  });
});
