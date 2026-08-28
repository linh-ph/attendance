import { describe, expect, it } from "vitest";
import { authConfig } from "./auth.config";

describe("Auth.js protected authorization", () => {
  it.each([
    ["allows a public page without a session", "/", null, true],
    ["allows Auth.js endpoints without a session", "/api/auth/session", null, true],
    ["allows health without a session", "/api/health", null, true],
    ["allows a protected path with an identity", "/dashboard", { user: { email: "manager@blended-asia.com" } }, true],
    ["rejects a protected path without an identity", "/dashboard", { user: {} }, false],
    [
      "rejects a protected path after a refresh failure",
      "/dashboard",
      { user: { email: "manager@blended-asia.com" }, error: "RefreshAccessTokenError" },
      false,
    ],
  ])("%s", (_description, path, auth, expected) => {
    expect(
      authConfig.callbacks.authorized({
        auth,
        request: { nextUrl: new URL(`https://attendance.test${path}`) },
      } as never),
    ).toBe(expected);
  });
});
