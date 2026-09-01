import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps the Supabase session fresh on every request.
 *
 * The refresh happens as a side effect of asking who the user is, so the
 * `getUser()` call below is not decoration: without it the cookie is never
 * rewritten and the session expires. The reference snippet in the Supabase
 * setup guide omits it, which is why this file differs from it.
 *
 * `getUser()` is used rather than `getSession()` deliberately — it revalidates
 * the token with Supabase instead of trusting whatever the cookie claims.
 *
 * The response object has to be the one Supabase wrote its cookies onto, so it
 * is returned rather than rebuilt by the caller.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseKey);
}

export async function refreshSupabaseSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  if (!supabaseUrl || !supabaseKey) return supabaseResponse;

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
  await supabase.auth.getUser();

  return supabaseResponse;
}
