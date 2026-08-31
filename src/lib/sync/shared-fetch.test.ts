import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSharedFetch, sharedFetch } from "./shared-fetch";

afterEach(() => {
  resetSharedFetch();
  vi.unstubAllGlobals();
});

/** A fetch whose responses are released by hand, so overlap is deterministic. */
function controllableFetch() {
  const releases: ((body: string) => void)[] = [];

  const mock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        releases.push((body) => resolve(new Response(body, { status: 200 })));
      }),
  );

  vi.stubGlobal("fetch", mock);

  return { mock, releaseAll: (body: string) => releases.forEach((release) => release(body)) };
}

describe("sharedFetch", () => {
  it("issues one request when two callers ask for the same URL at once", async () => {
    const { mock, releaseAll } = controllableFetch();

    const first = sharedFetch("/api/dashboard");
    const second = sharedFetch("/api/dashboard");

    expect(mock).toHaveBeenCalledTimes(1);

    releaseAll('{"timesheets":[]}');

    // Both get a readable body: each caller holds its own clone.
    expect(await (await first).json()).toEqual({ timesheets: [] });
    expect(await (await second).json()).toEqual({ timesheets: [] });
  });

  it("keeps different URLs apart", async () => {
    const { mock, releaseAll } = controllableFetch();

    void sharedFetch("/api/dashboard");
    void sharedFetch("/api/dashboard?folderId=folder-1");

    expect(mock).toHaveBeenCalledTimes(2);
    releaseAll("{}");
  });

  it("goes back to the server once the shared request has settled", async () => {
    const { mock, releaseAll } = controllableFetch();

    const first = sharedFetch("/api/dashboard");
    releaseAll("{}");
    await first;

    void sharedFetch("/api/dashboard");

    // No TTL, no stored answer: a later call is always a fresh request.
    expect(mock).toHaveBeenCalledTimes(2);
    releaseAll("{}");
  });

  it("shares a failure with every joiner and then forgets it", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", failing);

    await expect(sharedFetch("/api/dashboard")).rejects.toThrow("Failed to fetch");
    await expect(sharedFetch("/api/dashboard")).rejects.toThrow("Failed to fetch");

    expect(failing).toHaveBeenCalledTimes(2);
  });
});
