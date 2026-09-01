import { describe, expect, it, vi } from "vitest";
import { GoogleCredentialError, type GoogleCredentials } from "@/lib/supabase/google-credentials";
import { requireGoogleSessionFromRequest } from "./google-session";
import { UnauthenticatedError } from "./session";

/**
 * Which sign-in path answers a request, while both exist.
 *
 * The Auth.js fallback is exercised through its real reader with a stubbed JWT,
 * so these assert the actual composition rather than a mock of it.
 */

const request = new Request("https://example.test/api/dashboard");

function credentials(over: Partial<GoogleCredentials> = {}): GoogleCredentials {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    accessTokenFor: vi.fn(async () => "ya29.supabase"),
    ...over,
  };
}

describe("requireGoogleSessionFromRequest", () => {
  it("prefers the Supabase session when the request carries one", async () => {
    const session = await requireGoogleSessionFromRequest(request, {
      readUser: async () => ({ id: "user-1", email: "linh.np@blended-asia.com" }),
      credentials: credentials(),
    });

    expect(session).toEqual({
      email: "linh.np@blended-asia.com",
      accessToken: "ya29.supabase",
    });
  });

  it("falls back to the Auth.js cookie when there is no Supabase session", async () => {
    // Accounts that have not moved across yet must keep working unchanged.
    vi.stubEnv("AUTH_SECRET", "vitest-auth-secret");
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3100");

    const google = credentials();
    const session = await requireGoogleSessionFromRequest(request, {
      readUser: async () => null,
      credentials: google,
    });

    expect(session).toEqual({ email: "old@blended-asia.com", accessToken: "ya29.authjs" });
    // Nothing was asked of the credential store for a request that is not its own.
    expect(google.accessTokenFor).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("falls back when Supabase holds no credential store at all", async () => {
    vi.stubEnv("AUTH_SECRET", "vitest-auth-secret");

    const readUser = vi.fn(async () => ({ id: "user-1", email: "linh.np@blended-asia.com" }));
    await requireGoogleSessionFromRequest(request, { readUser, credentials: null });

    // Without a service role there is nothing to read a refresh token from, so
    // asking who the Supabase user is would be wasted work — and refusing them
    // outright would lock out every account.
    expect(readUser).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("does not fall back when a Supabase user is signed in but has no Google connection", async () => {
    // Falling back here would hand the request to Auth.js, which would refuse it
    // anyway — but with the wrong reason, hiding a revoked Google grant.
    await expect(
      requireGoogleSessionFromRequest(request, {
        readUser: async () => ({ id: "user-1", email: "linh.np@blended-asia.com" }),
        credentials: credentials({
          accessTokenFor: async () => {
            throw new GoogleCredentialError("refresh-failed", "invalid_grant");
          },
        }),
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

vi.mock("next-auth/jwt", () => ({
  getToken: async () => ({ email: "old@blended-asia.com", accessToken: "ya29.authjs" }),
}));
