/**
 * The single mechanical gate between a production deployment and the
 * deterministic non-production test adapter.
 *
 * Every factory that could return a test double — the Google gateway factory
 * and anything that mints a deterministic identity — asks this module first.
 * Two properties make that safe:
 *
 * 1. The environment is an argument, not a global read, so the guard is
 *    testable and a caller cannot accidentally consult a stale snapshot.
 * 2. The non-production allow-list is explicit. `production` throws when the
 *    flag is present at all, and an unrecognized `NODE_ENV` is off rather than
 *    on, so a mis-set variable fails closed.
 */

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** The exact opt-in value; anything else, including `"true"`, is not test mode. */
export const TEST_MODE_VALUE = "1";

export const TEST_MODE_VARIABLE = "E2E_TEST_MODE";
export const TEST_SECRET_VARIABLE = "E2E_TEST_SECRET";

export const PRODUCTION_TEST_MODE_MESSAGE = "E2E_TEST_MODE is forbidden in production";

/** The only environments in which a test adapter may ever be constructed. */
const NON_PRODUCTION_ENVIRONMENTS = new Set(["test", "development"]);

/**
 * Resolves whether the deterministic test adapter may be used.
 *
 * Throws — rather than returning `false` — when the flag is set in production,
 * because that combination is a deployment mistake that must be loud instead of
 * silently degrading to real Google calls.
 */
export function resolveTestMode(environment: RuntimeEnvironment): boolean {
  const isRequested = environment[TEST_MODE_VARIABLE] === TEST_MODE_VALUE;

  if (environment.NODE_ENV === "production") {
    if (isRequested) {
      throw new Error(PRODUCTION_TEST_MODE_MESSAGE);
    }
    return false;
  }

  return isRequested && NON_PRODUCTION_ENVIRONMENTS.has(environment.NODE_ENV ?? "");
}

/**
 * Constant-time comparison of the configured shared secret with the one a
 * request presented. An unset or empty configured secret can never be matched,
 * so forgetting to configure it locks the route rather than opening it.
 */
export function isTestSecretAccepted(
  environment: RuntimeEnvironment,
  presented: string | null | undefined,
): boolean {
  const configured = environment[TEST_SECRET_VARIABLE];

  if (typeof configured !== "string" || configured === "") return false;
  if (typeof presented !== "string" || presented === "") return false;
  if (presented.length !== configured.length) return false;

  // Length is already equal, so a plain character fold is constant time here.
  let difference = 0;
  for (let index = 0; index < configured.length; index += 1) {
    difference |= configured.charCodeAt(index) ^ presented.charCodeAt(index);
  }

  return difference === 0;
}
