import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

const secret = "test-secret";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadProxy() {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", "https://attendance.test");
  return (await import("./proxy")).proxy;
}

describe("exported Auth.js proxy", () => {
  it("redirects an unauthenticated protected request to login", async () => {
    const proxy = await loadProxy();

    const response = await proxy(new NextRequest("https://attendance.test/dashboard"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("redirects a protected request with a refresh-error session", async () => {
    const proxy = await loadProxy();
    const token = await encode({
      secret,
      salt: "__Secure-authjs.session-token",
      token: {
        email: "manager@blended-asia.com",
        error: "RefreshAccessTokenError",
      },
    });

    const response = await proxy(
      new NextRequest("https://attendance.test/dashboard", {
        headers: { cookie: `__Secure-authjs.session-token=${encodeURIComponent(token)}` },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("continues a protected request with a valid unexpired session", async () => {
    const proxy = await loadProxy();
    const token = await encode({
      secret,
      salt: "__Secure-authjs.session-token",
      token: {
        email: "manager@blended-asia.com",
        accessToken: "server-only-access-token",
        expiresAt: Date.now() + 60_000,
      },
    });

    const response = await proxy(
      new NextRequest("https://attendance.test/dashboard", {
        headers: { cookie: `__Secure-authjs.session-token=${encodeURIComponent(token)}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["/", "/login"])("bypasses Auth.js for public %s", async (path) => {
    const proxy = await loadProxy();
    const response = await proxy(new NextRequest(`https://attendance.test${path}`));

    expect(response.status).toBe(200);
  });
});
