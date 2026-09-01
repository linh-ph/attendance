import { createServerClient } from "@supabase/ssr";
import type { cookies } from "next/headers";

/**
 * The Supabase client for a server component, route handler, or server action.
 *
 * It is given the request's own cookie store, so every call carries the
 * signed-in user's Supabase session and Row Level Security applies to them
 * rather than to the application.
 *
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is public by design — it is the
 * anon/publishable key, safe in browser JS, and it grants nothing on its own.
 * Whatever it can reach is decided by RLS policies on the project. A service
 * role key must never appear in this file or in any `NEXT_PUBLIC_` variable.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type ServerCookieStore = Awaited<ReturnType<typeof cookies>>;

export function createClient(cookieStore: ServerCookieStore) {
  if (!supabaseUrl || !supabaseKey) {
    // Fail loudly at the boundary: a missing variable otherwise surfaces as an
    // opaque network error much later, in whichever query happened to run first.
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          /*
           * Called from a Server Component, which may not set cookies. Safe to
           * ignore only because the proxy below refreshes the session on every
           * request — without that, a session would expire and never renew.
           */
        }
      },
    },
  });
}
