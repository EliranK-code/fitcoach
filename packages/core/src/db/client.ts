import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { logger } from "../logger";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "pglite" | "postgres";
  close(): Promise<void>;
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * TLS for a Postgres URL. Any remote host gets TLS, so nothing crosses the network in the clear (Supabase
 * accepts plain connections unless "Enforce SSL" is on). `sslmode=verify-full` in the URL also checks the
 * certificate; a remote host without TLS takes an explicit `sslmode=disable` (e.g. a private network).
 */
export function postgresSsl(url: string): "require" | "verify-full" | false {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "require";
  }
  const mode = parsed.searchParams.get("sslmode");
  if (mode === "verify-full" || mode === "verify-ca") return "verify-full";
  if (mode === "require") return "require";
  if (mode === "disable") {
    if (!LOCAL_HOSTS.has(parsed.hostname)) logger.warn({ host: parsed.hostname }, "DATABASE_URL has sslmode=disable: database traffic is not encrypted");
    return false;
  }
  return LOCAL_HOSTS.has(parsed.hostname) ? false : "require";
}

/**
 * Opens the database and applies pending migrations.
 * - `databaseUrl` set → Postgres (Supabase in production).
 * - otherwise → PGlite (Postgres + pgvector compiled to WASM): `dataDir` on disk, or in-memory when omitted.
 */
export async function openDatabase(opts: { databaseUrl?: string; dataDir?: string; poolSize?: number }): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const ssl = postgresSsl(opts.databaseUrl);
    const sqlClient = postgres(opts.databaseUrl, { max: opts.poolSize ?? 10, prepare: false, onnotice: () => {}, ...(ssl ? { ssl } : {}) });
    const db = drizzlePostgres(sqlClient, { schema }) as unknown as Db;
    await migratePostgres(db as never, { migrationsFolder: MIGRATIONS_DIR });
    return { db, kind: "postgres", close: () => sqlClient.end() };
  }

  let releaseLock = () => {};
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    releaseLock = acquireDirLock(opts.dataDir);
  }
  const pg = new PGlite(opts.dataDir ?? "memory://", { extensions: { vector } });
  const db = drizzlePglite(pg, { schema }) as unknown as Db;
  await migratePglite(db as never, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db,
    kind: "pglite",
    close: async () => {
      await pg.close();
      releaseLock();
    },
  };
}

export class DatabaseBusyError extends Error {}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * PGlite is a single-process database: two processes opening the same directory corrupt it. A lock file
 * holding the owner's pid turns that into a clear error; a lock left by a crashed process is taken over.
 */
function acquireDirLock(dataDir: string): () => void {
  const lockPath = resolve(dataDir, "..", `${basename(dataDir)}.lock`);
  if (existsSync(lockPath)) {
    const [pidText, ...rest] = readFileSync(lockPath, "utf8").split("\n");
    const pid = Number(pidText);
    if (pid && pid !== process.pid && processAlive(pid)) {
      throw new DatabaseBusyError(
        `The local database (${dataDir}) is already open in another process (pid ${pid}: ${rest.join(" ").trim() || "unknown"}). ` +
          "PGlite supports only one process: stop the other one, or use Postgres through DATABASE_URL.",
      );
    }
  }
  const owner = [process.argv[1] ? basename(process.argv[1]) : "", ...process.argv.slice(2)].join(" ").trim();
  writeFileSync(lockPath, `${process.pid}\n${owner}`);
  const release = () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").startsWith(`${process.pid}\n`)) unlinkSync(lockPath);
    } catch {
      // Best effort: a stale lock is detected by pid next time.
    }
  };
  process.once("exit", release);
  return release;
}
