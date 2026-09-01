import { describe, expect, it, vi } from "vitest";
import type { TokenFetch } from "@/lib/auth/google-token";
import {
  GoogleCredentialError,
  createGoogleCredentials,
  type CredentialTable,
  type StoredGoogleCredential,
} from "./google-credentials";
import { generateKey } from "./token-crypto";

const USER = "11111111-2222-3333-4444-555555555555";
const REFRESH_TOKEN = "1//0g_fake_refresh_token";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const KEY = generateKey();

/** An in-memory stand-in for the `google_credentials` table. */
function fakeTable() {
  const rows = new Map<string, StoredGoogleCredential>();
  const writes: string[] = [];

  const table: CredentialTable = {
    async read(userId) {
      return rows.get(userId) ?? null;
    },
    async write(userId, refreshToken, scopes) {
      writes.push(refreshToken);
      rows.set(userId, { refresh_token: refreshToken, scopes });
    },
    async remove(userId) {
      rows.delete(userId);
    },
  };

  return { table, rows, writes };
}

function tokenEndpoint(body: Record<string, unknown>, ok = true): TokenFetch {
  return vi.fn(async () => ({ ok, json: async () => body }));
}

const credentials = (over: Partial<Parameters<typeof createGoogleCredentials>[0]> = {}) => {
  const store = fakeTable();
  return {
    store,
    subject: createGoogleCredentials({
      table: store.table,
      encryptionKey: KEY,
      fetcher: tokenEndpoint({ access_token: "ya29.fresh", expires_in: 3600 }),
      now: () => 1_000_000,
      ...over,
    }),
  };
};

describe("connect", () => {
  it("never writes the refresh token in the clear", async () => {
    const { store, subject } = credentials();

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);

    const stored = store.rows.get(USER);
    expect(stored?.refresh_token).not.toContain(REFRESH_TOKEN);
    expect(stored?.refresh_token.startsWith("v1.")).toBe(true);
    expect(stored?.scopes).toEqual(SCOPES);
  });
});

describe("accessTokenFor", () => {
  it("exchanges the stored refresh token for a live access token", async () => {
    const fetcher = tokenEndpoint({ access_token: "ya29.fresh", expires_in: 3600 });
    const { subject } = credentials({ fetcher });

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);

    expect(await subject.accessTokenFor(USER)).toBe("ya29.fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The plaintext token reached Google, and only Google.
    const body = (fetcher as unknown as { mock: { calls: [string, { body: string }][] } }).mock
      .calls[0][1].body;
    expect(body).toContain(encodeURIComponent(REFRESH_TOKEN));
  });

  it("reports an account with no stored connection as such, not as a failure", async () => {
    const { subject } = credentials();

    const error = await subject.accessTokenFor(USER).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GoogleCredentialError);
    expect((error as GoogleCredentialError).code).toBe("not-connected");
  });

  it("reports a refused refresh distinctly, so the caller can ask for consent", async () => {
    const { subject } = credentials({ fetcher: tokenEndpoint({ error: "invalid_grant" }, false) });

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);
    const error = await subject.accessTokenFor(USER).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GoogleCredentialError);
    expect((error as GoogleCredentialError).code).toBe("refresh-failed");
  });

  it("persists a rotated refresh token, so a long session keeps working", async () => {
    const { store, subject } = credentials({
      fetcher: tokenEndpoint({
        access_token: "ya29.fresh",
        expires_in: 3600,
        refresh_token: "1//0g_rotated",
      }),
    });

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);
    const writesAfterConnect = store.writes.length;

    await subject.accessTokenFor(USER);

    expect(store.writes.length).toBe(writesAfterConnect + 1);
    // Still encrypted, and still the same scopes.
    expect(store.rows.get(USER)?.refresh_token.startsWith("v1.")).toBe(true);
    expect(store.rows.get(USER)?.scopes).toEqual(SCOPES);
  });

  it("does not rewrite the row when Google returns the same token", async () => {
    const { store, subject } = credentials({
      fetcher: tokenEndpoint({
        access_token: "ya29.fresh",
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
      }),
    });

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);
    const writesAfterConnect = store.writes.length;

    await subject.accessTokenFor(USER);

    expect(store.writes.length).toBe(writesAfterConnect);
  });

  it("refuses a row it cannot decrypt rather than sending rubbish to Google", async () => {
    const { store, subject } = credentials();

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);
    // Someone with database access, but not the application key.
    store.rows.set(USER, { refresh_token: "v1.aaaa.bbbb.cccc", scopes: SCOPES });

    await expect(subject.accessTokenFor(USER)).rejects.toThrow(/could not be decrypted/);
  });

  it("is scoped per user: one person's row is never another's", async () => {
    const { store, subject } = credentials();

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);

    expect(store.rows.has("99999999-9999-9999-9999-999999999999")).toBe(false);
    await expect(
      subject.accessTokenFor("99999999-9999-9999-9999-999999999999"),
    ).rejects.toMatchObject({ code: "not-connected" });
  });
});

describe("disconnect", () => {
  it("forgets the credential", async () => {
    const { store, subject } = credentials();

    await subject.connect(USER, REFRESH_TOKEN, SCOPES);
    await subject.disconnect(USER);

    expect(store.rows.has(USER)).toBe(false);
  });
});
