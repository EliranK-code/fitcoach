import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticate,
  createCoachUser,
  createSession,
  deleteSession,
  hashPassword,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  PasswordPolicyError,
  SESSION_TTL_MS,
  setPassword,
  validateSession,
  verifyPassword,
} from "../src/auth";
import { openDatabase, type DbHandle } from "../src/db/client";
import { createCoach } from "../src/tenancy";

let handle: DbHandle;
let coachId: string;

beforeAll(async () => {
  handle = await openDatabase({});
  coachId = await createCoach(handle.db, { slug: "auth-coach", name: "מאמן" });
});
afterAll(async () => {
  await handle.close();
});

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(hash); // salted
  });

  it("enforces a minimum length", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(PasswordPolicyError);
  });
});

describe("login", () => {
  it("accepts the right password, case-insensitive email", async () => {
    await createCoachUser(handle.db, { coachId, email: "Coach@Example.com", password: "a-long-password-1" });
    const res = await authenticate(handle.db, "coach@example.COM", "a-long-password-1");
    expect(res.ok).toBe(true);
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    expect(await authenticate(handle.db, "nobody@example.com", "whatever-password")).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate(handle.db, "coach@example.com", "wrong-password-xx")).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks the account after repeated failures, then unlocks", async () => {
    await createCoachUser(handle.db, { coachId, email: "lock@example.com", password: "a-long-password-2" });
    const now = new Date("2026-10-16T10:00:00Z");
    let last;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) last = await authenticate(handle.db, "lock@example.com", "nope-nope-nope", now);
    expect(last).toEqual({ ok: false, reason: "locked" });
    // Even the right password is refused while locked.
    expect(await authenticate(handle.db, "lock@example.com", "a-long-password-2", now)).toEqual({ ok: false, reason: "locked" });
    const later = new Date(now.getTime() + LOCKOUT_MS + 1000);
    expect((await authenticate(handle.db, "lock@example.com", "a-long-password-2", later)).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("validates, expires and revokes sessions bound to the coach", async () => {
    const user = await createCoachUser(handle.db, { coachId, email: "s@example.com", password: "a-long-password-3" });
    const now = new Date("2026-10-16T10:00:00Z");
    const { token } = await createSession(handle.db, user, now);
    const valid = await validateSession(handle.db, token, now);
    expect(valid?.coachId).toBe(coachId);
    expect(valid?.user.email).toBe("s@example.com");
    expect(await validateSession(handle.db, `${token}x`, now)).toBeNull();
    expect(await validateSession(handle.db, undefined, now)).toBeNull();
    expect(await validateSession(handle.db, token, new Date(now.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    await deleteSession(handle.db, token);
    expect(await validateSession(handle.db, token, now)).toBeNull();
  });

  it("ends every session when the password changes", async () => {
    const user = await createCoachUser(handle.db, { coachId, email: "pw@example.com", password: "a-long-password-4" });
    const a = await createSession(handle.db, user);
    const b = await createSession(handle.db, user);
    await setPassword(handle.db, user.id, "a-brand-new-password");
    expect(await validateSession(handle.db, a.token)).toBeNull();
    expect(await validateSession(handle.db, b.token)).toBeNull();
    expect((await authenticate(handle.db, "pw@example.com", "a-brand-new-password")).ok).toBe(true);
  });
});
