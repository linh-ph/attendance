import type { NextConfig } from "next";

/**
 * Vercel sets `VERCEL=1` in every build and runtime environment it owns.
 *
 * It matters here because the two deploy targets want opposite things from
 * `next build`. The Dockerfile's runner stage copies `.next/standalone`, so
 * this repository's own image needs standalone output. Vercel builds its own
 * output instead, and asking Next for standalone there makes the build die
 * looking for a trace file it never wrote:
 *
 *   ENOENT: no such file or directory, open '.next/next-server.js.nft.json'
 *
 * So the option is set everywhere except on Vercel, rather than dropped.
 * Dropping it would trade a broken preview for a broken production image.
 */
const isVercelBuild = process.env.VERCEL === "1";

const nextConfig: NextConfig = {
  ...(isVercelBuild ? {} : { output: "standalone" as const }),

  /**
   * `next dev` refuses to serve its own `/_next` development assets to a host
   * it does not recognize, and its built-in allow-list is `localhost` plus the
   * bound hostname. The browser proof drives the app at `http://127.0.0.1:3100`
   * (see `playwright.config.ts`), so that loopback address has to be named here
   * or every page renders without its client bundle.
   *
   * This option is read only by the development router; `next build` and the
   * production server ignore it entirely.
   */
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
