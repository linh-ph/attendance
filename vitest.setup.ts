import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Vitest runs without `globals`, so Testing Library never registers its own
 * automatic cleanup. Without this, every `render()` accumulates in the document
 * and each test after the first sees duplicated elements.
 */
afterEach(cleanup);
