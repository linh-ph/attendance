import { describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@/lib/auth/session";
import { GoogleCredentialError, type GoogleCredentials } from "./google-credentials";
import { googleSessionFromSupabase, type SupabaseAuthUser } from "./session";

const USER: SupabaseAuthUser = { id: "user-1", email: "Linh.NP@Blended-Asia.com" };

function credentials(over: Partial<GoogleCredentials> = {}): GoogleCredentials {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    accessTokenFor: vi.fn(async () => "ya29.live"),
    ...over,
  };
}

const request = new Request("https://example.test/api/dashboard");

describe("googleSessionFromSupabase", () => {
  it("resolves a signed-in person to a live Google access token", async () => {
    const google = credentials();

    const session = await googleSessionFromSupabase(request, {
      readUser: async () => USER,
      credentials: google,
    });

    expect(session).toEqual({ email: "linh.np@blended-asia.com", accessToken: "ya29.live" });
    // The credential is addressed by the Supabase user id, never by anything
    // the browser supplied.
    expect(google.accessTokenFor).toHaveBeenCalledWith("user-1");
  });

  it("returns null when there is no Supabase session, so the caller can fall back", async () => {
    // During the migration both sign-in paths exist. Absence here is not a
    // refusal — it means this request belongs to the other one.
    expect(
      await googleSessionFromSupabase(request, {
        readUser: async () => null,
        credentials: credentials(),
      }),
    ).toBeNull();
  });

  it("refuses a Supabase user with no email rather than inventing an identity", async () => {
    // Every authorization decision downstream is keyed on the normalized email.
    await expect(
      googleSessionFromSupabase(request, {
        readUser: async () => ({ id: "user-1", email: null }),
        credentials: credentials(),
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("refuses when the person is signed in but has no stored Google connection", async () => {
    await expect(
      googleSessionFromSupabase(request, {
        readUser: async () => USER,
        credentials: credentials({
          accessTokenFor: async () => {
            throw new GoogleCredentialError("not-connected", "no connection");
          },
        }),
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("refuses when Google will no longer refresh the connection", async () => {
    await expect(
      googleSessionFromSupabase(request, {
        readUser: async () => USER,
        credentials: credentials({
          accessTokenFor: async () => {
            throw new GoogleCredentialError("refresh-failed", "invalid_grant");
          },
        }),
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("lets an unexpected storage failure surface as itself, not as a sign-in prompt", async () => {
    // A database outage is not the person's fault and must not read as
    // "sign in again" — that would loop them through consent forever.
    const outage = new Error("connection refused");

    await expect(
      googleSessionFromSupabase(request, {
        readUser: async () => USER,
        credentials: credentials({
          accessTokenFor: async () => {
            throw outage;
          },
        }),
      }),
    ).rejects.toBe(outage);
  });
});
