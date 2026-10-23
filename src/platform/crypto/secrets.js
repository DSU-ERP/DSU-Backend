// AES-256-GCM secret storage for platform credentials (GitHub tokens) and
// short-lived OAuth verifiers. Keys live only in backend env:
//   INTEGRATION_ENCRYPTION_KEYS   "kid:base64,kid2:base64" (each exactly 32 bytes)
//   INTEGRATION_ENCRYPTION_KEY_ID current kid used for new ciphertext
// Ciphertext format: v1.<kid>.<iv b64url>.<tag b64url>.<ct b64url>. Every
// ciphertext is bound to additional authenticated data (for credentials: the
// account id and credential kind) so a cipher copied to another row fails.
// Plaintext is never logged or included in error messages.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { httpError } from "../http/errors.js";

const KID = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

export function notConfigured() {
  return httpError(
    503,
    "INTEGRATIONS_NOT_CONFIGURED",
    "Platform connections are not configured on this server yet.",
  );
}

/** Parses "kid:base64,..." into a Map of kid -> 32-byte Buffer. Throws on any invalid entry. */
export function parseKeys(value) {
  const keys = new Map();
  for (const entry of String(value || "").split(",").map((v) => v.trim()).filter(Boolean)) {
    const at = entry.indexOf(":");
    const kid = entry.slice(0, at);
    const material = entry.slice(at + 1);
    if (at < 1 || !KID.test(kid) || keys.has(kid))
      throw new Error("Invalid INTEGRATION_ENCRYPTION_KEYS entry");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(material))
      throw new Error("Invalid INTEGRATION_ENCRYPTION_KEYS entry");
    const key = Buffer.from(material, "base64");
    if (key.length !== 32) throw new Error("Each integration key must be 32 bytes");
    keys.set(kid, key);
  }
  return keys;
}

/** True when the env holds a usable key set (same rule env.js enforces). */
export function keysValid(keysValue, keyId) {
  try {
    return !!keyId && parseKeys(keysValue).has(keyId);
  } catch {
    return false;
  }
}

const aadBuffer = (aad) => {
  if (typeof aad !== "string" || !aad) throw new Error("Additional authenticated data is required");
  return Buffer.from(aad, "utf8");
};

/**
 * createSecrets(env) never throws for missing config; the functions do, with a
 * 503 INTEGRATIONS_NOT_CONFIGURED error, so routes can report it cleanly.
 */
export function createSecrets(env = {}) {
  let keys = null;
  let current = null;
  try {
    if (env.INTEGRATION_ENCRYPTION_KEYS && env.INTEGRATION_ENCRYPTION_KEY_ID) {
      const parsed = parseKeys(env.INTEGRATION_ENCRYPTION_KEYS);
      if (parsed.has(env.INTEGRATION_ENCRYPTION_KEY_ID)) {
        keys = parsed;
        current = env.INTEGRATION_ENCRYPTION_KEY_ID;
      }
    }
  } catch {
    keys = null;
  }
  const ensure = () => {
    if (!keys) throw notConfigured();
  };
  return Object.freeze({
    get configured() {
      return !!keys;
    },
    get keyId() {
      return current;
    },
    encrypt(plaintext, aad) {
      ensure();
      if (typeof plaintext !== "string" || !plaintext) throw new Error("Nothing to encrypt");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys.get(current), iv);
      cipher.setAAD(aadBuffer(aad));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ["v1", current, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
    },
    decrypt(value, aad) {
      ensure();
      const parts = typeof value === "string" ? value.split(".") : [];
      const fail = () => Object.assign(new Error("Stored secret could not be decrypted"), { code: "SECRET_UNREADABLE" });
      if (parts.length !== 5 || parts[0] !== "v1" || !KID.test(parts[1]) || !parts.slice(2).every((p) => B64URL.test(p)))
        throw fail();
      const key = keys.get(parts[1]);
      if (!key) throw Object.assign(fail(), { code: "SECRET_KEY_UNKNOWN" });
      const iv = Buffer.from(parts[2], "base64url");
      const tag = Buffer.from(parts[3], "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw fail();
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aadBuffer(aad));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw fail();
      }
    },
    /** True when the cipher was written with a key other than the current one. */
    needsRotation(value) {
      ensure();
      const kid = typeof value === "string" ? value.split(".")[1] : null;
      return kid !== current;
    },
    /** Key id embedded in a cipher (stored next to it for operators). */
    keyIdOf(value) {
      return typeof value === "string" ? value.split(".")[1] || null : null;
    },
  });
}
