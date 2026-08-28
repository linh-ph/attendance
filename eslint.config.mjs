import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

/**
 * The application shares this repository with the Harness install, brainstorm
 * artefacts, and any isolated implementation worktree under `.worktrees/`.
 * A worktree is a complete second copy of the tree, build output included, so
 * these ignores are matched at any depth — a top-level `.next/**` pattern
 * misses `.worktrees/<branch>/.next/**` and linting it exhausts the heap.
 */
export default defineConfig([
  ...nextVitals,
  globalIgnores([
    "**/.next/**",
    "**/node_modules/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    ".worktrees/**",
    ".brainstorm/**",
    ".harness-core/**",
    ".agents/**",
  ]),
]);
