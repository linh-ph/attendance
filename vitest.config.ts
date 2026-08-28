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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**"],
    server: {
      deps: { inline: ["next-auth", "@auth/core"] },
    },
  },
});
