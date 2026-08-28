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

  it("evaluates Auth.js only for protected paths", async () => {
    const authenticatedProxy = vi.fn().mockResolvedValue(new Response("protected"));
    const proxy = createProxy(authenticatedProxy);

    await expect(proxy(new NextRequest("https://attendance.test/dashboard"))).resolves.toEqual(
      expect.any(Response),
    );
    expect(authenticatedProxy).toHaveBeenCalledTimes(1);
  });
});
