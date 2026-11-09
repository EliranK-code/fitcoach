import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, isSensitiveKey, logger } from "../src/logger";
import { createDryRunApi, logDryRun, maskPhone } from "../src/whatsapp/api";

// Logs never hold message bodies, phone numbers, profiles, emails, tokens or passwords (CLAUDE.md).
// All values below are fake.

function capture() {
  const lines: string[] = [];
  const log = createLogger({ write: (s: string) => void lines.push(s) }, "info");
  return { log, text: () => lines.join("") };
}

const PHONE = "15550001234";
const SECRETS = {
  text: "my knee hurts when I squat",
  body: "message body",
  phone: PHONE,
  to: PHONE,
  from: PHONE,
  email: "client@example.com",
  password: "hunter2-fake",
  token: "tok-fake-123",
  accessToken: "EAAG-fake-access",
  appSecret: "fake-app-secret",
  authorization: "Bearer fake-bearer",
  profile: { name: "Dana Client" },
  phoneHash: "fakehash0001",
  bodyEnc: "fakeciphertext01",
  totpSecretEnc: "fakeciphertext02",
};

describe("log redaction", () => {
  it("censors every sensitive field at the top level and nested inside objects and arrays", () => {
    const { log, text } = capture();
    log.info({ ...SECRETS, clientId: "c-1" }, "top");
    log.info({ job: { ...SECRETS, clientId: "c-1" } }, "one deep");
    log.info({ payload: { entry: [{ changes: [{ value: { messages: [{ ...SECRETS }] } }] }] } }, "webhook-shaped");
    const out = text();
    for (const value of Object.values(SECRETS).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)))) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain("[redacted]");
    // Identifiers that aren't personal data stay readable.
    expect(out).toContain('"clientId":"c-1"');
  });

  it("matches names case-insensitively and by suffix, but leaves ids alone", () => {
    for (const key of ["Phone", "clientPhone", "WA_ID", "refreshToken", "passwordHash", "summaryEnc", "params"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["clientId", "coachId", "phoneNumberId", "messageId", "model", "code", "scope"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("doesn't change the caller's object", () => {
    const { log } = capture();
    const fields = { phone: PHONE, nested: { email: "client@example.com" } };
    log.info(fields, "x");
    expect(fields).toEqual({ phone: PHONE, nested: { email: "client@example.com" } });
  });

  it("keeps a failed query's SQL but drops its parameters, from the message, the stack and the fields", () => {
    const { log, text } = capture();
    const cause = new Error('duplicate key value violates unique constraint "clients_phone"');
    const err = new DrizzleQueryError("insert into clients (phone_hash, notes) values ($1, $2)", ["fakehash0001", "fake private note\nsecond line"], cause);
    log.error({ err, clientId: "c-1" }, "turn job failed");
    // Also when the failed query is the cause of another error.
    log.error({ err: new Error("turn failed", { cause: err }) }, "wrapped");
    const out = text();
    expect(out).not.toContain("fakehash0001");
    expect(out).not.toContain("fake private note");
    expect(out).not.toContain("second line");
    expect(out).toContain("insert into clients (phone_hash, notes)");
    expect(out).toContain("params: [redacted]");
    expect(out).toContain("duplicate key value violates unique constraint");
  });

  it("censors sensitive fields attached to an error", () => {
    const { log, text } = capture();
    log.error({ err: Object.assign(new Error("send failed"), { to: PHONE, code: 131030 }) }, "x");
    expect(text()).not.toContain(PHONE);
    expect(text()).toContain("131030");
  });
});

describe("WhatsApp dry run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the message type, never the recipient or the text", async () => {
    const info = vi.spyOn(logger, "info");
    const api = createDryRunApi("pn-1");
    await api.sendText(PHONE, "my knee hurts when I squat");
    await api.sendTemplate(PHONE, "checkin", "en", ["Dana"]);
    await api.markRead("wamid.1", false);
    expect(info).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain("knee");
    expect(logged).not.toContain("Dana");
    expect(info.mock.calls[0]![0]).toEqual({ dryRun: "text", phoneNumberId: "pn-1" });
    // The simulation still records everything for the terminal and for tests.
    expect(api.sent[0]).toMatchObject({ to: PHONE, body: "my knee hurts when I squat" });
    // Custom sinks (the terminal printers) still get the full entry.
    const custom: unknown[] = [];
    await createDryRunApi("pn-1", (e) => custom.push(e)).sendText(PHONE, "hi");
    expect(custom).toEqual([{ phoneNumberId: "pn-1", to: PHONE, type: "text", body: "hi" }]);
    expect(logDryRun({ phoneNumberId: "pn-1", type: "read", body: "wamid.1" })).toBeUndefined();
  });

  it("shows only the last digits of a number on screen", () => {
    expect(maskPhone(PHONE)).toBe("…1234");
    expect(maskPhone(undefined)).toBe("?");
    expect(maskPhone("123")).toBe("…3");
  });
});

// `.gitignore` must keep secrets, backups and database dumps out of a public repo, without hiding tracked files.
const root = resolve(__dirname, "../../..");
const inGitRepo = existsSync(join(root, ".git"));

describe.skipIf(!inGitRepo)(".gitignore", () => {
  const ignored = (path: string) => {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it("ignores env files, keys, certificates, backups and database dumps", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.production",
      "apps/dashboard/.env.local",
      "prod.env",
      ".envrc",
      "server.key",
      "certs/fullchain.pem",
      "AuthKey_ABC.p8",
      "store.p12",
      "id_rsa",
      "id_ed25519.pub",
      ".env.bak",
      "notes.backup",
      "config.ts.orig",
      "supabase.dump",
      "dump-2026-11-09.sql",
      "backup.sql",
      "db.sql.gz",
      "local.sqlite",
      "app.db",
      ".data/pglite/PG_VERSION",
    ]) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it("keeps the template, the migrations and the source tracked", () => {
    for (const path of [".env.example", "packages/core/drizzle/0001_init.sql", "packages/core/src/logger.ts", "README.md"]) {
      expect(ignored(path), path).toBe(false);
    }
    const trackedButIgnored = execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    expect(trackedButIgnored.trim()).toBe("");
  });
});
