import { describe, expect, it, vi } from "vitest";

/**
 * Build output is a deployment contract, and it points two ways.
 *
 * The Dockerfile's runner stage copies `.next/standalone`, so losing that
 * output silently breaks the deploy this repository actually ships. Vercel is
 * the exception: it produces its own output, and Next's standalone step fails
 * there while looking for a trace file it never wrote —
 * `ENOENT … .next/next-server.js.nft.json`.
 *
 * Both halves are asserted because either one alone is a regression that only
 * shows up at deploy time.
 */

async function loadConfigWith(vercel: string | undefined) {
  const previous = process.env.VERCEL;

  if (vercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = vercel;

  try {
    vi.resetModules();
    const loaded = await import("../next.config");
    return loaded.default;
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
}

describe("next.config", () => {
  it("emits standalone output so the Docker runner stage has something to copy", async () => {
    const config = await loadConfigWith(undefined);

    expect(config.output).toBe("standalone");
  });

  it("leaves the output to Vercel when the build runs there", async () => {
    const config = await loadConfigWith("1");

    expect(config.output).toBeUndefined();
  });

  it("keeps the loopback dev origin the browser proof depends on", async () => {
    const config = await loadConfigWith(undefined);

    expect(config.allowedDevOrigins).toContain("127.0.0.1");
  });
});
