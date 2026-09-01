/**
 * The shape a module needs from the environment.
 *
 * Narrower than `NodeJS.ProcessEnv`, which requires `NODE_ENV` and so forces
 * every test to cast a two-key literal. `process.env` satisfies this, so the
 * production call site is unchanged and the tests describe exactly the
 * variables under test.
 */
export type EnvSource = Record<string, string | undefined>;
