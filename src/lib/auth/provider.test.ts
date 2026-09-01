import { describe, expect, it } from "vitest";
import { resolveAuthProvider } from "./provider";

describe("resolveAuthProvider", () => {
  it("stays on Auth.js unless an operator opts in", () => {
    // Supabase can be configured here while its Google provider is not yet
    // configured in the Supabase dashboard. Defaulting to Supabase in that
    // state would make signing in impossible with no way back.
    expect(resolveAuthProvider({})).toBe("authjs");
    expect(resolveAuthProvider({ AUTH_PROVIDER: "" })).toBe("authjs");
    expect(resolveAuthProvider({ AUTH_PROVIDER: "sup" })).toBe("authjs");
  });

  it("switches on an explicit opt-in, however it was typed", () => {
    expect(resolveAuthProvider({ AUTH_PROVIDER: "supabase" })).toBe(
      "supabase",
    );
    expect(resolveAuthProvider({ AUTH_PROVIDER: " Supabase " })).toBe(
      "supabase",
    );
  });
});
