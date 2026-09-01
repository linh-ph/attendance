import type { EnvSource } from "@/lib/env";

/**
 * Which sign-in path the login page offers.
 *
 * This is an explicit switch, not a guess from configuration. Supabase can be
 * fully configured here while the Google provider is still unconfigured in the
 * Supabase dashboard — and in that state, offering the Supabase button would
 * make signing in impossible with no way back. So the default stays `authjs`
 * until an operator has completed
 * `docs/runbooks/supabase-auth-setup.md` and sets `AUTH_PROVIDER=supabase`.
 *
 * Both paths keep working in the API either way: `google-session.ts` accepts a
 * Supabase session and an Auth.js cookie at once, so flipping this does not
 * sign anyone out.
 */

export type AuthProvider = "authjs" | "supabase";

export function resolveAuthProvider(env: EnvSource = process.env): AuthProvider {
  return env.AUTH_PROVIDER?.trim().toLowerCase() === "supabase" ? "supabase" : "authjs";
}
