import { createServerClient } from "@supabase/ssr";
import type { EnvSource } from "@/lib/env";
import type { SupabaseAuthUser, SupabaseUserReader } from "./session";

/**
 * Reading the Supabase user out of a request's own cookies.
 *
 * `getUser` is used rather than `getSession` on purpose: `getSession` returns
 * whatever the cookie claims, which a browser can write, while `getUser`
 * revalidates the token with Supabase. Every authorization decision in this
 * application follows from the identity resolved here, so it has to be the
 * verified one.
 *
 * Cookies are read, never written. The proxy already refreshes the session on
 * every request; a route handler that also tried to set them would race it.
 */

export function isSupabaseConfigured(env: EnvSource = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

export function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) {
    return [];
  }

  return header
    .split(";")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator === -1) {
        return null;
      }

      const name = pair.slice(0, separator).trim();
      if (!name) {
        return null;
      }

      return { name, value: decodeURIComponent(pair.slice(separator + 1).trim()) };
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

export function createRequestUserReader(
  env: EnvSource = process.env,
): SupabaseUserReader {
  return async function readUser(request: Request): Promise<SupabaseAuthUser | null> {
    if (!isSupabaseConfigured(env)) {
      return null;
    }

    const client = createServerClient(
      env.NEXT_PUBLIC_SUPABASE_URL as string,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
      {
        cookies: {
          getAll: () => parseCookieHeader(request.headers.get("cookie")),
          setAll: () => {
            /* Read-only: the proxy owns cookie refresh. */
          },
        },
      },
    );

    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      // No Supabase session on this request. Not a refusal — the caller decides
      // whether another sign-in path still applies.
      return null;
    }

    return { id: data.user.id, email: data.user.email ?? null };
  };
}
