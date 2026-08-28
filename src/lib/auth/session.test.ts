import { describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { authConfig } from "@/auth.config";
import {
  UnauthenticatedError,
  requireGoogleSession,
  requireGoogleSessionFromRequest,
  usesSecureCookie,
  toApiErrorResponse,
} from "./session";

describe("requireGoogleSession", () => {
  it("normalizes an authenticated Google identity", async () => {
    await expect(
      requireGoogleSession({
        session: { user: { email: "Manager@Blended-Asia.com" } },
        token: { accessToken: "a" },
      }),
    ).resolves.toEqual({ email: "manager@blended-asia.com", accessToken: "a" });
  });

  it.each([
    { session: { user: { email: null } }, token: { accessToken: "a" } },
    { session: { user: { email: "manager@blended-asia.com" } }, token: {} },
    {
      session: { user: { email: "manager@blended-asia.com" } },
      token: { accessToken: "a", error: "RefreshAccessTokenError" as const },
    },
  ])("rejects an incomplete or failed provider session", async (input) => {
    await expect(requireGoogleSession(input)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("decodes the encrypted server JWT through an injectable reader", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
    const readJwt = vi.fn().mockResolvedValue({
      email: "Manager@Blended-Asia.com",
      accessToken: "server-only-access-token",
    });

    await expect(
      requireGoogleSessionFromRequest(new Request("https://attendance.test/api/dashboard"), readJwt),
    ).resolves.toEqual({
      email: "manager@blended-asia.com",
      accessToken: "server-only-access-token",
    });

    expect(readJwt).toHaveBeenCalledWith(expect.objectContaining({ secret: "test-secret" }));
    vi.unstubAllEnvs();
  });

  it.each([
    ["http", "http://attendance.test/api/dashboard", "authjs.session-token"],
    ["https", "https://attendance.test/api/dashboard", "__Secure-authjs.session-token"],
  ])("uses the Auth.js %s cookie name and salt", async (_protocol, url, cookieName) => {
    const secret = "test-secret";
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("AUTH_URL", "");
    const encryptedToken = await encode({
      secret,
      salt: cookieName,
      token: { email: "Manager@Blended-Asia.com", accessToken: "server-only-access-token" },
    });

    await expect(
      requireGoogleSessionFromRequest(
        new Request(url, { headers: { cookie: `${cookieName}=${encodeURIComponent(encryptedToken)}` } }),
      ),
    ).resolves.toEqual({
      email: "manager@blended-asia.com",
      accessToken: "server-only-access-token",
    });
    vi.unstubAllEnvs();
  });

  it("falls back to a secure cookie when configured and request URLs are malformed", () => {
    expect(usesSecureCookie({ url: "not a URL" }, "also not a URL")).toBe(true);
  });
});

describe("authentication API mapping", () => {
  it("maps unauthenticated access to a generic no-store 401 response", async () => {
    const response = toApiErrorResponse(new UnauthenticatedError());

    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expect(response?.json()).resolves.toEqual({ error: "Authentication required." });
  });
});

describe("Auth.js session callback", () => {
  it("does not serialize Google provider tokens into the browser session", () => {
    const browserSession = authConfig.callbacks.session({
      session: { user: { email: "Manager@Blended-Asia.com" }, expires: "2030-01-01" },
      token: {
        accessToken: "provider-access-token",
        refreshToken: "provider-refresh-token",
        error: "RefreshAccessTokenError",
      },
    } as never);

    expect(browserSession).toEqual({
      user: { email: "manager@blended-asia.com" },
      expires: "2030-01-01",
      error: "RefreshAccessTokenError",
    });
    expect(JSON.stringify(browserSession)).not.toContain("provider-access-token");
    expect(JSON.stringify(browserSession)).not.toContain("provider-refresh-token");
    expect(browserSession).not.toHaveProperty("accessToken");
    expect(browserSession).not.toHaveProperty("refreshToken");
  });
});
