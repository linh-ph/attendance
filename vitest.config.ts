import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "next/server": path.resolve(__dirname, "node_modules/next/server.js"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // `tests/**` carries suites that are not tied to one source module, such as
    // the optional reference-workbook proof. Playwright specs live under
    // `tests/e2e` and are run by `npm run test:e2e`, never by Vitest.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    server: {
      deps: { inline: ["next-auth", "@auth/core"] },
    },
  },
});
