import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
