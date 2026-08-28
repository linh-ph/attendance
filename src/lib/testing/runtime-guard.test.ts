import { describe, expect, it } from "vitest";
import {
  PRODUCTION_TEST_MODE_MESSAGE,
  isTestSecretAccepted,
  resolveTestMode,
} from "./runtime-guard";

/**
 * The guard is the only thing standing between a production deployment and the
 * deterministic test adapter, so it is proven before the adapter exists.
 *
 * It takes its environment as an argument: nothing here mutates `process.env`,
 * and every production factory can therefore be asked the same question without
 * a global side effect.
 */
describe("resolveTestMode", () => {
  it("enables the test adapter under NODE_ENV=test", () => {
    expect(resolveTestMode({ NODE_ENV: "test", E2E_TEST_MODE: "1" })).toBe(true);
  });

  it("enables the test adapter under NODE_ENV=development", () => {
    expect(resolveTestMode({ NODE_ENV: "development", E2E_TEST_MODE: "1" })).toBe(true);
  });

  it("refuses to run at all when the flag is set in production", () => {
    expect(() => resolveTestMode({ NODE_ENV: "production", E2E_TEST_MODE: "1" })).toThrow(
      "E2E_TEST_MODE is forbidden in production",
    );
  });

  it("is off in production without the flag", () => {
    expect(resolveTestMode({ NODE_ENV: "production" })).toBe(false);
  });

  it("exports the production refusal message it throws", () => {
    expect(PRODUCTION_TEST_MODE_MESSAGE).toBe("E2E_TEST_MODE is forbidden in production");
  });

  it("is off without the flag in every non-production environment", () => {
    expect(resolveTestMode({ NODE_ENV: "test" })).toBe(false);
    expect(resolveTestMode({ NODE_ENV: "development" })).toBe(false);
    expect(resolveTestMode({})).toBe(false);
  });

  it("only accepts the exact opt-in value", () => {
    expect(resolveTestMode({ NODE_ENV: "development", E2E_TEST_MODE: "true" })).toBe(false);
    expect(resolveTestMode({ NODE_ENV: "development", E2E_TEST_MODE: "0" })).toBe(false);
    expect(resolveTestMode({ NODE_ENV: "development", E2E_TEST_MODE: "" })).toBe(false);
  });

  it("stays off for an unrecognized NODE_ENV, because the allow-list is explicit", () => {
    expect(resolveTestMode({ NODE_ENV: "staging", E2E_TEST_MODE: "1" })).toBe(false);
    expect(resolveTestMode({ E2E_TEST_MODE: "1" })).toBe(false);
  });

  it("throws for a production flag whatever else the environment carries", () => {
    expect(() =>
      resolveTestMode({ NODE_ENV: "production", E2E_TEST_MODE: "1", E2E_TEST_SECRET: "anything" }),
    ).toThrow(PRODUCTION_TEST_MODE_MESSAGE);
  });
});

describe("isTestSecretAccepted", () => {
  it("accepts only an exact match with the configured secret", () => {
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "shared" }, "shared")).toBe(true);
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "shared" }, "Shared")).toBe(false);
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "shared" }, "shared ")).toBe(false);
  });

  it("refuses when the request sends no secret", () => {
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "shared" }, null)).toBe(false);
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "shared" }, "")).toBe(false);
  });

  it("refuses when the server has no secret configured, so an empty header cannot pass", () => {
    expect(isTestSecretAccepted({}, "")).toBe(false);
    expect(isTestSecretAccepted({}, null)).toBe(false);
    expect(isTestSecretAccepted({ E2E_TEST_SECRET: "" }, "")).toBe(false);
  });
});
