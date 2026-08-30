import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Vitest runs without `globals`, so Testing Library never registers its own
 * automatic cleanup. Without this, every `render()` accumulates in the document
 * and each test after the first sees duplicated elements.
 */
afterEach(cleanup);

/**
 * jsdom implements no layout, so it ships no `scrollIntoView` at all. Code that
 * brings an element into view is ordinary browser behavior, and a test should
 * not have to know it exists — only the tests that assert *on* the scrolling
 * replace this with their own spy.
 */
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
