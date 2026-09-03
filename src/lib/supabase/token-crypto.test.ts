import { describe, expect, it } from "vitest";
import {
  TokenCryptoError,
  decryptToken,
  encryptToken,
  generateKey,
  readKey,
} from "./token-crypto";

const key = readKey(generateKey());
const otherKey = readKey(generateKey());

const REFRESH_TOKEN = "1//0gV9k_fake_refresh_token_for_tests_only";

describe("readKey", () => {
  it("accepts a 32-byte base64 key", () => {
    expect(readKey(generateKey())).toHaveLength(32);
  });

  it("refuses a key of the wrong size rather than reshaping it", () => {
    // Padding or hashing a short key into shape would encrypt real credentials
    // under a key nobody chose, and only fail much later on read.
    expect(() => readKey(Buffer.alloc(16).toString("base64"))).toThrow(TokenCryptoError);
    expect(() => readKey(Buffer.alloc(64).toString("base64"))).toThrow(TokenCryptoError);
  });

  it("refuses a missing key", () => {
    expect(() => readKey(undefined)).toThrow(/not set/);
    expect(() => readKey("")).toThrow(/not set/);
  });

  it("accepts 64 hex characters, which is what `secrets.token_hex(32)` produces", () => {
    const hex = "a".repeat(64);

    expect(readKey(hex)).toHaveLength(32);
    expect(readKey(hex.toUpperCase())).toEqual(readKey(hex));
    // A trailing newline is what a shell redirect leaves in a .env file.
    expect(readKey(` ${hex}\n`)).toEqual(readKey(hex));
  });

  it("reads a hex key as hex, not as the 48 bytes it also base64-decodes to", () => {
    // Hex digits are valid base64 characters, so getting this wrong would not
    // throw — it would encrypt under a different key than the operator set.
    const hex = "a".repeat(64);

    expect(readKey(hex)).toEqual(Buffer.from(hex, "hex"));
    expect(readKey(hex)).not.toEqual(Buffer.from(hex, "base64").subarray(0, 32));
  });

  it("still refuses hex of the wrong length", () => {
    expect(() => readKey("ab".repeat(16))).toThrow(TokenCryptoError);
  });
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a refresh token", () => {
    expect(decryptToken(encryptToken(REFRESH_TOKEN, key), key)).toBe(REFRESH_TOKEN);
  });

  it("never writes the token in the clear", () => {
    const payload = encryptToken(REFRESH_TOKEN, key);

    expect(payload).not.toContain(REFRESH_TOKEN);
    expect(payload).not.toContain("refresh_token");
  });

  it("produces a different ciphertext every time, so equal tokens do not look equal", () => {
    const first = encryptToken(REFRESH_TOKEN, key);
    const second = encryptToken(REFRESH_TOKEN, key);

    expect(first).not.toBe(second);
    expect(decryptToken(first, key)).toBe(decryptToken(second, key));
  });

  it("carries a version so a future rotation can tell schemes apart", () => {
    expect(encryptToken(REFRESH_TOKEN, key).startsWith("v1.")).toBe(true);
  });

  it("refuses the wrong key without saying it was the key", () => {
    const payload = encryptToken(REFRESH_TOKEN, key);

    expect(() => decryptToken(payload, otherKey)).toThrow(TokenCryptoError);
    expect(() => decryptToken(payload, otherKey)).toThrow("could not be decrypted");
  });

  it("rejects a tampered ciphertext instead of decrypting rubbish", () => {
    const [version, iv, tag, ciphertext] = encryptToken(REFRESH_TOKEN, key).split(".");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 0xff;

    const tampered = [version, iv, tag, flipped.toString("base64")].join(".");

    // Authenticated encryption: the tag catches this. Without it the token would
    // decrypt to nonsense and then be sent to Google as if it were real.
    expect(() => decryptToken(tampered, key)).toThrow(TokenCryptoError);
  });

  it("rejects a tampered authentication tag", () => {
    const [version, iv, tag, ciphertext] = encryptToken(REFRESH_TOKEN, key).split(".");
    const flipped = Buffer.from(tag, "base64");
    flipped[0] ^= 0xff;

    expect(() =>
      decryptToken([version, iv, flipped.toString("base64"), ciphertext].join("."), key),
    ).toThrow(TokenCryptoError);
  });

  it("rejects a payload that is not in this format at all", () => {
    expect(() => decryptToken(REFRESH_TOKEN, key)).toThrow(/not in a format/);
    expect(() => decryptToken("v2.a.b.c", key)).toThrow(/not in a format/);
    expect(() => decryptToken("", key)).toThrow(/not in a format/);
  });

  it("refuses to encrypt nothing", () => {
    expect(() => encryptToken("", key)).toThrow(/empty token/);
  });
});
