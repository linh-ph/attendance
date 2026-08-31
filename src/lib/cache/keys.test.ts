import { describe, expect, it } from "vitest";
import {
  CACHE_SCHEMA_VERSION,
  contextKey,
  draftCacheKey,
  findCredentialMaterial,
  monthCacheKey,
  normalizeAccount,
  parseCacheKey,
  type CacheContext,
} from "./keys";

const context = (over: Partial<CacheContext> = {}): CacheContext => ({
  email: "linh.np@blended-asia.com",
  fileId: "file-1",
  sheetId: "101",
  month: "2026-07",
  ...over,
});

describe("cache keys", () => {
  it("normalizes the account so one address in two casings is one scope", () => {
    expect(normalizeAccount("  Linh.NP@Blended-Asia.com ")).toBe("linh.np@blended-asia.com");
    expect(contextKey(context({ email: "LINH.NP@BLENDED-ASIA.COM" }))).toBe(contextKey(context()));
  });

  it("scopes a key by account, file, sheet, month, and schema version", () => {
    const base = contextKey(context());

    expect(base).toContain(`v${CACHE_SCHEMA_VERSION}`);
    expect(base).not.toBe(contextKey(context({ email: "other@b.com" })));
    expect(base).not.toBe(contextKey(context({ fileId: "file-2" })));
    expect(base).not.toBe(contextKey(context({ sheetId: "102" })));
    expect(base).not.toBe(contextKey(context({ month: "2026-08" })));
    expect(base).not.toBe(contextKey(context(), CACHE_SCHEMA_VERSION + 1));
  });

  it("keeps the month key and the draft key in separate namespaces", () => {
    expect(draftCacheKey(context(), "2026-07-03")).not.toBe(monthCacheKey(context()));
    expect(draftCacheKey(context(), "2026-07-03")).not.toBe(draftCacheKey(context(), "2026-07-04"));
  });

  it("parses a key back to its parts so a migration can scan without guessing", () => {
    expect(parseCacheKey(monthCacheKey(context()))).toEqual({
      schemaVersion: CACHE_SCHEMA_VERSION,
      account: "linh.np@blended-asia.com",
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
      date: null,
    });

    expect(parseCacheKey(draftCacheKey(context(), "2026-07-03"))?.date).toBe("2026-07-03");
    expect(parseCacheKey("nonsense")).toBe(null);
    expect(parseCacheKey("vX::a@b.com::f::1::2026-07")).toBe(null);
  });
});

describe("credential material is not storable", () => {
  it("names the offending path when a record carries a token-shaped property", () => {
    expect(findCredentialMaterial({ view: { accessToken: "x" } })).toBe("view.accessToken");
    expect(findCredentialMaterial({ refresh_token: "x" })).toBe("refresh_token");
    expect(findCredentialMaterial({ headers: { Authorization: "x" } })).toBe("headers.Authorization");
    expect(findCredentialMaterial({ a: [{ cookie: "s=1" }] })).toBe("a.0.cookie");
    expect(findCredentialMaterial({ session: { idToken: "x" } })).toBe("session.idToken");
    expect(findCredentialMaterial({ clientSecret: "x" })).toBe("clientSecret");
  });

  it("names the offending path when a value looks like a Google token or a JWT", () => {
    expect(findCredentialMaterial({ notes: "ya29.a0AfH6SMB-not-a-real-token" })).toBe("notes");
    expect(
      findCredentialMaterial({
        notes:
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    ).toBe("notes");
  });

  it("names the offending path for an authorization result, not just a credential", () => {
    // `AttendanceMonthView.role` is assigned straight from `authorizeFile`, and
    // `access/policy.ts` says "never a cached role". Spec §5.1 puts
    // authorization results in the same never-store class as tokens.
    expect(findCredentialMaterial({ view: { role: "manager" } })).toBe("view.role");
    expect(findCredentialMaterial({ authorized: true })).toBe("authorized");
    expect(findCredentialMaterial({ permissions: ["write"] })).toBe("permissions");
  });

  it("accepts an ordinary attendance record", () => {
    expect(
      findCredentialMaterial({
        view: {
          month: "2026-07",
          sheetTitle: "NGUYEN PHAN LINH",
          days: [{ date: "2026-07-03", notes: "late train" }],
        },
      }),
    ).toBe(null);
  });
});
