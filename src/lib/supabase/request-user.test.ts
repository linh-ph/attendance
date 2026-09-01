import { describe, expect, it } from "vitest";
import { createRequestUserReader, isSupabaseConfigured, parseCookieHeader } from "./request-user";

describe("parseCookieHeader", () => {
  it("reads the cookies a browser actually sends", () => {
    expect(parseCookieHeader("sb-access-token=abc; sb-refresh-token=def")).toEqual([
      { name: "sb-access-token", value: "abc" },
      { name: "sb-refresh-token", value: "def" },
    ]);
  });

  it("decodes a percent-encoded value, which Supabase chunks contain", () => {
    expect(parseCookieHeader("sb-auth=%7B%22a%22%3A1%7D")).toEqual([
      { name: "sb-auth", value: '{"a":1}' },
    ]);
  });

  it("keeps a value that itself contains '='", () => {
    // Base64 padding. Splitting on every '=' would truncate the token.
    expect(parseCookieHeader("sb-auth=eyJhbGciOi==")).toEqual([
      { name: "sb-auth", value: "eyJhbGciOi==" },
    ]);
  });

  it("survives a missing or malformed header instead of throwing", () => {
    expect(parseCookieHeader(null)).toEqual([]);
    expect(parseCookieHeader("")).toEqual([]);
    expect(parseCookieHeader("novalue; =orphan; a=1")).toEqual([{ name: "a", value: "1" }]);
  });
});

describe("createRequestUserReader", () => {
  it("reports no user when Supabase is not configured, rather than constructing a client", async () => {
    const readUser = createRequestUserReader({});

    expect(await readUser(new Request("https://example.test/"))).toBeNull();
  });
});

describe("isSupabaseConfigured", () => {
  it("needs both the URL and the publishable key", () => {
    expect(isSupabaseConfigured({})).toBe(false);
    expect(
      isSupabaseConfigured({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }),
    ).toBe(false);
    expect(
      isSupabaseConfigured({
        NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      }),
    ).toBe(true);
  });
});
