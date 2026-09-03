import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createProxy } from "./lib/auth/proxy";

describe("proxy boundary", () => {
  it("bypasses Auth.js for public paths before session evaluation", async () => {
    const authenticatedProxy = vi.fn();
    const proxy = createProxy(authenticatedProxy);

    const response = await proxy(new NextRequest("https://attendance.test/login"));

    expect(response.status).toBe(200);
    expect(authenticatedProxy).not.toHaveBeenCalled();
  });

  it("serves a public static asset without evaluating Auth.js", async () => {
    const authenticatedProxy = vi.fn();
    const proxy = createProxy(authenticatedProxy);

    // The sign-in screen's artwork is fetched before anyone has a session, and
    // Next's image optimizer requests the source file over HTTP.
    const response = await proxy(new NextRequest("https://attendance.test/meme.jpeg"));

    expect(response.status).toBe(200);
    expect(authenticatedProxy).not.toHaveBeenCalled();
  });

  it("still evaluates Auth.js for an API path that looks like a file", async () => {
    const authenticatedProxy = vi.fn().mockResolvedValue(new Response("protected"));
    const proxy = createProxy(authenticatedProxy);

    await proxy(new NextRequest("https://attendance.test/api/dashboard/export.json"));

    expect(authenticatedProxy).toHaveBeenCalledTimes(1);
  });

  it("evaluates Auth.js only for protected paths", async () => {
    const authenticatedProxy = vi.fn().mockResolvedValue(new Response("protected"));
    const proxy = createProxy(authenticatedProxy);

    await expect(proxy(new NextRequest("https://attendance.test/dashboard"))).resolves.toEqual(
      expect.any(Response),
    );
    expect(authenticatedProxy).toHaveBeenCalledTimes(1);
  });

  it("never lets a browser cache the redirect to /login", async () => {
    // Cached, it is replayed after signing in — bouncing a valid session back
    // to the login page without ever reaching the server.
    const proxy = createProxy(vi.fn().mockResolvedValue(undefined));

    const response = await proxy(new NextRequest("https://attendance.test/dashboard"));

    expect(response.status).toBe(307);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lets Google's sign-in return through without a session", async () => {
    // The authorization code is spent at /auth/callback. Gating it would
    // redirect to /login before the exchange, so sign-in could never finish.
    const authenticatedProxy = vi.fn();
    const proxy = createProxy(authenticatedProxy);

    const response = await proxy(
      new NextRequest("https://attendance.test/auth/callback?code=abc"),
    );

    expect(response.status).toBe(200);
    expect(authenticatedProxy).not.toHaveBeenCalled();
  });
});
