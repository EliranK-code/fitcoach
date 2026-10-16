import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseBusyError, openDatabase, type DbHandle } from "../src/db/client";
import { ConversationEngine } from "../src/engine/conversation";
import { importCoachFromDir } from "../src/knowledge/importer";
import { searchKnowledge } from "../src/knowledge/store";
import { openTenant } from "../src/tenancy";
import { connectWhatsAppNumber } from "../src/whatsapp/accounts";
import { claimDueJobs, enqueueInbound } from "../src/whatsapp/inbox";
import { FakeLlm, message, SEED_DIR, testConfig, text } from "./helpers";

// The production path (DATABASE_URL → postgres-js → Supabase) talks the Postgres wire protocol. PGlite
// exposed over a socket lets us exercise that exact driver, migrator and SQL (SKIP LOCKED, pgvector) offline.
describe("Postgres driver path (DATABASE_URL)", () => {
  let pg: PGlite;
  let socket: PGLiteSocketServer;
  let handle: DbHandle;

  beforeAll(async () => {
    pg = await PGlite.create({ extensions: { vector } });
    const port = 54000 + Math.floor(Math.random() * 1000);
    socket = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 1 });
    await socket.start();
    // One connection: PGlite is a single session, so a larger pool would interleave transactions.
    handle = await openDatabase({ databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, poolSize: 1 });
  });

  afterAll(async () => {
    await handle?.close();
    await socket?.stop();
    await pg?.close();
  });

  it("runs migrations, imports a coach and handles a turn over the wire protocol", async () => {
    expect(handle.kind).toBe("postgres");
    const cfg = testConfig();
    const { coachId } = await importCoachFromDir(handle.db, SEED_DIR, { cfg, llm: null, embedder: null, slug: "demo" });
    const t = await openTenant(handle.db, coachId);
    expect((await searchKnowledge(handle.db, t, "דילואד", null))[0]?.content).toContain("דילואד");

    await connectWhatsAppNumber(handle.db, t, { phoneNumberId: "pn-pg" });
    const now = new Date();
    await enqueueInbound(handle.db, [{ phoneNumberId: "pn-pg", from: "972500000009", id: "w-pg-1", timestamp: now, kind: "text", text: "היי" }], {
      debounceMs: 0,
      now,
    });
    const jobs = await claimDueJobs(handle.db, { now: new Date(now.getTime() + 1), limit: 5, leaseMs: 60_000 });
    expect(jobs).toHaveLength(1);

    const llm = new FakeLlm().push(message([text("היי! איך קוראים לך?")]));
    const engine = new ConversationEngine({ db: handle.db, cfg, llm: () => llm, embedder: null, now: () => new Date() });
    await engine.handleInbound({ coachId, phone: "cli-pg", text: "היי", channel: "cli" });
    const res = await engine.handleInbound({ coachId, phone: "cli-pg", text: "מאשר", channel: "cli" });
    expect(res.replies[0]).toContain("איך קוראים לך");
  });
});

describe("local PGlite lock", () => {
  it("refuses to open a data directory another live process holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fitcoach-lock-"));
    const dataDir = join(dir, "pglite");
    try {
      // The parent process (vitest's runner) is alive and isn't us: simulate it holding the lock.
      writeFileSync(join(dir, "pglite.lock"), `${process.ppid}\nnpm run server`);
      await expect(openDatabase({ dataDir })).rejects.toBeInstanceOf(DatabaseBusyError);

      // A lock left by a dead process is taken over.
      writeFileSync(join(dir, "pglite.lock"), "999999\ncrashed");
      const handle = await openDatabase({ dataDir });
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
