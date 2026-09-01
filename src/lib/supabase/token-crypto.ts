import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the one secret this application now keeps: a
 * person's Google refresh token.
 *
 * Storing that token is a deliberate, owner-approved reversal of the app's
 * founding rule that it holds no credentials
 * (`docs/decisions/2026-09-02-supabase-holds-google-credentials.md`). A refresh
 * token does not expire on its own, so a row of this table is durable authority
 * to act as that person in Drive and Sheets. Two consequences shape this file:
 *
 * - **Encrypted at rest, with a key the database does not hold.** Reading the
 *   table is not enough; an attacker needs the application's key as well.
 * - **Authenticated, not merely encrypted.** AES-256-GCM's tag is verified on
 *   decrypt, so a tampered ciphertext is rejected rather than decrypting to
 *   rubbish that would then be sent to Google.
 *
 * Node-only: `node:crypto` is unavailable on the Edge runtime, so nothing that
 * runs in the proxy may import this.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/**
 * Reads the 32-byte key from a base64 string.
 *
 * A wrong-sized key is refused rather than padded or hashed into shape: silently
 * accepting one would mean encrypting real credentials under a key nobody
 * intended, and the error would only surface as undecryptable rows later.
 */
export function readKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new TokenCryptoError("GOOGLE_TOKEN_ENCRYPTION_KEY is not set.");
  }

  let key: Buffer;
  try {
    key = Buffer.from(base64Key, "base64");
  } catch {
    throw new TokenCryptoError("GOOGLE_TOKEN_ENCRYPTION_KEY is not valid base64.");
  }

  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `GOOGLE_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }

  return key;
}

/**
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64.
 *
 * The version prefix is what makes a future key or algorithm rotation possible:
 * a reader can tell which scheme produced a row instead of guessing.
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  if (plaintext === "") {
    throw new TokenCryptoError("Refusing to encrypt an empty token.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptToken(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError("Stored credential is not in a format this build understands.");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key and a tampered ciphertext both land here, and the message
    // deliberately does not say which.
    throw new TokenCryptoError("Stored credential could not be decrypted.");
  }
}

/** Generates a key for the runbook. Not used by the application itself. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
