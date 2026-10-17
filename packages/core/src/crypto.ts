import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { loadConfig } from "./config";

// Envelope encryption: one random data key (DEK) per coach, wrapped by the master key from the environment.
// Every ciphertext is bound to its coach via AES-GCM associated data, so a value copied into another
// tenant's row fails to decrypt instead of leaking.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FIELD_PREFIX = "e1.";
const DEK_PREFIX = "k1.";

export class EncryptionConfigError extends Error {}

let masterKeyCache: Buffer | undefined;

export function getMasterKey(): Buffer {
  if (masterKeyCache) return masterKeyCache;
  const raw = loadConfig().MASTER_ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionConfigError(
      "MASTER_ENCRYPTION_KEY חסר. הריצו npm run setup כדי ליצור אותו בקובץ .env",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new EncryptionConfigError("MASTER_ENCRYPTION_KEY חייב להיות 32 בייטים בקידוד base64");
  }
  masterKeyCache = key;
  return key;
}

export function generateKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function wrapDataKey(dek: Buffer, coachId: string): string {
  return DEK_PREFIX + seal(getMasterKey(), dek, `dek:${coachId}`);
}

export function unwrapDataKey(wrapped: string, coachId: string): Buffer {
  if (!wrapped.startsWith(DEK_PREFIX)) throw new Error("Unknown data-key format");
  return open(getMasterKey(), wrapped.slice(DEK_PREFIX.length), `dek:${coachId}`);
}

export interface CipherScope {
  coachId: string;
  dek: Buffer;
}

export function encryptText(scope: CipherScope, plaintext: string): string {
  return FIELD_PREFIX + seal(scope.dek, Buffer.from(plaintext, "utf8"), `coach:${scope.coachId}`);
}

export function decryptText(scope: CipherScope, sealed: string): string {
  if (!sealed.startsWith(FIELD_PREFIX)) throw new Error("Unknown ciphertext format");
  return open(scope.dek, sealed.slice(FIELD_PREFIX.length), `coach:${scope.coachId}`).toString("utf8");
}

export function encryptJson(scope: CipherScope, value: unknown): string {
  return encryptText(scope, JSON.stringify(value));
}

export function decryptJson<T>(scope: CipherScope, sealed: string): T {
  return JSON.parse(decryptText(scope, sealed)) as T;
}

export function encryptOptional(scope: CipherScope, plaintext: string | null | undefined): string | null {
  return plaintext == null || plaintext === "" ? null : encryptText(scope, plaintext);
}

export function decryptOptional(scope: CipherScope, sealed: string | null | undefined): string | null {
  return sealed ? decryptText(scope, sealed) : null;
}

let platformKeyCache: Buffer | undefined;

/**
 * Encryption scope for platform secrets that belong to no coach (admins' TOTP secrets): a key derived from
 * the master key, so nothing extra has to be stored or configured.
 */
export function platformScope(): CipherScope {
  platformKeyCache ??= Buffer.from(hkdfSync("sha256", getMasterKey(), Buffer.alloc(0), "platform-secrets-v1", KEY_BYTES));
  return { coachId: "platform", dek: platformKeyCache };
}

let hashKeyCache: Buffer | undefined;

function hashKey(): Buffer {
  hashKeyCache ??= Buffer.from(hkdfSync("sha256", getMasterKey(), Buffer.alloc(0), "phone-hash-v1", KEY_BYTES));
  return hashKeyCache;
}

/** Normalizes Israeli/international phone numbers to digits with country code; other identifiers are lower-cased. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (/[a-z]/i.test(trimmed)) return trimmed.toLowerCase();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  return digits;
}

/** Keyed hash per coach: the same phone under two coaches yields unrelated hashes. */
export function phoneHash(coachId: string, phone: string): string {
  return createHmac("sha256", hashKey()).update(`${coachId}:${normalizePhone(phone)}`).digest("hex");
}

/** For tests that swap MASTER_ENCRYPTION_KEY. */
export function resetKeyCaches(): void {
  masterKeyCache = undefined;
  hashKeyCache = undefined;
  platformKeyCache = undefined;
}
