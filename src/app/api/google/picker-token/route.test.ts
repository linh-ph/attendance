import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { GET } from "./route";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const URL = "http://attendance.test/api/google/picker-token";

async function signedRequest(token: Record<string, unknown>): Promise<Request> {
  const encrypted = await encode({ secret: SECRET, salt: COOKIE_NAME, token });
  return new Request(URL, {
    headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(encrypted)}` },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/google/picker-token", () => {
  it("returns only the short-lived access token to an authenticated browser", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    vi.stubEnv("AUTH_URL", "");

    const response = await GET(
      await signedRequest({
        email: "Manager@Blended-Asia.com",
        accessToken: "provider-access-token",
        refreshToken: "provider-refresh-token",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ accessToken: "provider-access-token" });
    expect(body).not.toContain("provider-refresh-token");
    expect(body).not.toContain("refreshToken");
    expect(body).not.toContain("refresh_token");
  });

  it("rejects an anonymous request without leaking a token", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    vi.stubEnv("AUTH_URL", "");

    const response = await GET(new Request(URL));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("rejects a session whose provider authorization can no longer be refreshed", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    vi.stubEnv("AUTH_URL", "");

    const response = await GET(
      await signedRequest({
        email: "manager@blended-asia.com",
        accessToken: "provider-access-token",
        error: "RefreshAccessTokenError",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("provider-access-token");
  });
});
