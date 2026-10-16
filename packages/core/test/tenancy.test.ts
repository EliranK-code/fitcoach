import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptText } from "../src/crypto.js";
import { openDatabase, type DbHandle } from "../src/db/client.js";
import { importCoachFromDir } from "../src/knowledge/importer.js";
import { buildKnowledgePrompt, getKnowledge, publishKnowledge, searchKnowledge } from "../src/knowledge/store.js";
import { renderCoachKnowledge } from "../src/knowledge/render.js";
import { deleteClientData, exportClientData, purgeInactiveClients } from "../src/privacy.js";
import { findOrCreateClient, getClient, getProfile, saveProfile, updateClient } from "../src/repos/clients.js";
import { createAlert, listAlerts } from "../src/repos/ops.js";
import { addWeight, listWeights } from "../src/repos/tracking.js";
import { createCoach, openTenant, type TenantContext } from "../src/tenancy.js";
import { SEED_DIR, testConfig } from "./helpers.js";

let handle: DbHandle;
let a: TenantContext;
let b: TenantContext;

beforeAll(async () => {
  handle = await openDatabase({});
  const cfg = testConfig();
  const imported = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
  a = await openTenant(handle.db, imported.coachId);
  b = await openTenant(handle.db, await createCoach(handle.db, { slug: "other", name: "מאמנת אחרת" }));
  const data = (await getKnowledge(handle.db, a))!.data;
  await publishKnowledge(
    handle.db,
    b,
    {
      data: { ...data, coach: { ...data.coach, name: "מאמנת אחרת" } },
      documents: [{ title: "סודות", filename: "secret.md", mime: "text/markdown", text: "המתכון הסודי של המאמנת השנייה: שייק בננה וחמאת בוטנים" }],
    },
    null,
  );
});

afterAll(async () => {
  await handle.close();
});

describe("tenant isolation", () => {
  it("keeps the same phone as separate clients under different coaches", async () => {
    const ca = await findOrCreateClient(handle.db, a, { phone: "0501111111", channel: "cli" });
    const cb = await findOrCreateClient(handle.db, b, { phone: "0501111111", channel: "cli" });
    expect(ca.client.id).not.toBe(cb.client.id);
    expect(ca.client.phoneHash).not.toBe(cb.client.phoneHash);
  });

  it("never returns another coach's client, profile, logs or alerts", async () => {
    const { client } = await findOrCreateClient(handle.db, a, { phone: "0502222222", channel: "cli" });
    await saveProfile(handle.db, a, client.id, { name: "רק של א" });
    await addWeight(handle.db, a, client.id, 80, "2026-10-01");
    await createAlert(handle.db, a, { clientId: client.id, type: "medical", severity: "high", source: "system", summary: "סודי" });

    expect(await getClient(handle.db, b, client.id)).toBeUndefined();
    expect(await getProfile(handle.db, b, client.id)).toEqual({});
    expect(await listWeights(handle.db, b, client.id)).toEqual([]);
    expect((await listAlerts(handle.db, b)).some((al) => al.clientId === client.id)).toBe(false);
    await expect(updateClient(handle.db, b, client.id, { botPaused: true })).rejects.toThrow();
    expect(await deleteClientData(handle.db, b, client.id, "test")).toBe(false);
    await expect(exportClientData(handle.db, b, client.id, "test")).rejects.toThrow();
    // Ciphertext copied across tenants does not decrypt.
    expect(() => decryptText(b, client.phoneEnc)).toThrow();
    expect(await getClient(handle.db, a, client.id)).toBeDefined();
  });

  it("searches only the coach's own documents", async () => {
    const own = await searchKnowledge(handle.db, b, "מתכון סודי שייק", null);
    expect(own[0]?.documentTitle).toBe("סודות");
    const other = await searchKnowledge(handle.db, a, "מתכון סודי שייק בננה חמאת בוטנים", null);
    expect(other.some((h) => h.content.includes("חמאת בוטנים"))).toBe(false);
  });
});

describe("knowledge", () => {
  it("renders deterministically (prompt-cache safe)", async () => {
    const k = (await getKnowledge(handle.db, a))!;
    expect(renderCoachKnowledge(k.data, k.version, [])).toBe(renderCoachKnowledge(k.data, k.version, []));
  });

  it("inlines small document sets and switches to search mode for large ones", async () => {
    const inline = await buildKnowledgePrompt(handle.db, a, 30_000);
    expect(inline.ragMode).toBe(false);
    expect(inline.text).toContain("שיטת כף היד");
    expect(inline.text).toContain("<document title=");
    const rag = await buildKnowledgePrompt(handle.db, a, 500);
    expect(rag.ragMode).toBe(true);
    expect(rag.text).not.toContain("<document title=");
  });

  it("finds relevant passages by keyword without embeddings", async () => {
    const hits = await searchKnowledge(handle.db, a, "דילואד אחרי כמה שבועות", null);
    expect(hits[0]?.content).toContain("דילואד");
  });

  it("bumps the knowledge version on every publish", async () => {
    const before = (await openTenant(handle.db, a.coachId)).knowledgeVersion;
    await publishKnowledge(handle.db, a, {}, null);
    expect((await openTenant(handle.db, a.coachId)).knowledgeVersion).toBe(before + 1);
  });
});

describe("retention", () => {
  it("purges clients inactive beyond the retention period", async () => {
    const { client: old } = await findOrCreateClient(handle.db, b, { phone: "0503333333", channel: "cli" });
    await updateClient(handle.db, b, old.id, { lastInboundAt: new Date("2023-01-01T00:00:00Z") });
    const { client: fresh } = await findOrCreateClient(handle.db, b, { phone: "0504444444", channel: "cli" });
    await updateClient(handle.db, b, fresh.id, { lastInboundAt: new Date() });
    const removed = await purgeInactiveClients(handle.db, b, 24);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await getClient(handle.db, b, old.id)).toBeUndefined();
    expect(await getClient(handle.db, b, fresh.id)).toBeDefined();
  });
});
