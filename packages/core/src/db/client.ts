import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "pglite" | "postgres";
  close(): Promise<void>;
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Opens the database and applies pending migrations.
 * - `databaseUrl` set → Postgres (Supabase in production).
 * - otherwise → PGlite (Postgres + pgvector compiled to WASM): `dataDir` on disk, or in-memory when omitted.
 */
export async function openDatabase(opts: { databaseUrl?: string; dataDir?: string }): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const sqlClient = postgres(opts.databaseUrl, { max: 10, prepare: false });
    const db = drizzlePostgres(sqlClient, { schema }) as unknown as Db;
    await migratePostgres(db as never, { migrationsFolder: MIGRATIONS_DIR });
    return { db, kind: "postgres", close: () => sqlClient.end() };
  }

  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const pg = new PGlite(opts.dataDir ?? "memory://", { extensions: { vector } });
  const db = drizzlePglite(pg, { schema }) as unknown as Db;
  await migratePglite(db as never, { migrationsFolder: MIGRATIONS_DIR });
  return { db, kind: "pglite", close: () => pg.close() };
}
