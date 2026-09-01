import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps the Supabase session fresh on every request, and reports whether there
 * is one.
 *
 * The refresh happens as a side effect of asking who the user is, so the
 * `getUser()` call below is not decoration: without it the cookie is never
 * rewritten and the session expires. The reference snippet in the Supabase
 * setup guide omits it, which is why this file differs from it.
 *
 * `getUser()` is used rather than `getSession()` deliberately — it revalidates
 * the token with Supabase instead of trusting whatever the cookie claims. Since
 * the proxy lets a request through on the strength of that answer, trusting the
 * cookie here would let a browser write itself a session.
 *
 * The response object has to be the one Supabase wrote its cookies onto, so it
 * is returned rather than rebuilt by the caller.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export interface SupabaseRefresh {
  response: NextResponse;
  /** The verified user id, or `null` when this request has no Supabase session. */
  userId: string | null;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseKey);
}

export async function refreshSupabaseSession(request: NextRequest): Promise<SupabaseRefresh> {
  let supabaseResponse = NextResponse.next({ request });

  if (!supabaseUrl || !supabaseKey) return { response: supabaseResponse, userId: null };

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        supabaseResponse = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // Revalidates the token and, as a side effect, rewrites the session cookie.
  const { data, error } = await supabase.auth.getUser();

  return {
    response: supabaseResponse,
    userId: error || !data.user ? null : data.user.id,
  };
}
