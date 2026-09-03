import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { GOOGLE_SCOPES } from "@/lib/auth/scopes";
import { createGoogleCredentials } from "@/lib/supabase/google-credentials";
import { createSupabaseCredentialTable, hasServiceRole } from "@/lib/supabase/credential-table";
import { parseCookieHeader } from "@/lib/supabase/request-user";

/**
 * Where Supabase returns after Google consent.
 *
 * This is the **only** moment Google hands over a refresh token: it comes back
 * once, on this exchange, and never again for the same grant. Supabase does not
 * keep it and does not refresh the Google token afterwards, so if it is not
 * stored here the person's Drive and Sheets access dies about an hour later and
 * only another consent screen can revive it. Hence the failure handling below —
 * a lost token is reported, never swallowed.
 *
 * **The session cookies are written onto the response this handler returns**,
 * not through `cookies()` from `next/headers`. That distinction is the whole
 * reason this route builds its own Supabase client instead of reusing
 * `lib/supabase/server.ts`, and it was measured, not guessed: cookies written
 * to the `next/headers` store are not attached to a `NextResponse.redirect`
 * constructed here, so the exchange succeeded, the refresh token was stored,
 * `auth.users` and `google_credentials` both had rows — and the browser was
 * still handed a redirect carrying no session, landing back on `/login` with
 * every server-side sign of success. Collecting the cookies in a jar and
 * applying them to whichever response is returned is what completes sign-in.
 */

const SIGNED_IN_AT = "/dashboard";

type Cookie = { name: string; value: string; options: CookieOptions };

function withCookies(response: NextResponse, jar: readonly Cookie[]): NextResponse {
  for (const { name, value, options } of jar) {
    response.cookies.set(name, value, options);
  }

  return response;
}

function failure(origin: string, reason: string): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? SIGNED_IN_AT;

  if (!code) {
    // Google reports a declined consent this way, with `error` alongside.
    return failure(url.origin, url.searchParams.get("error") ?? "no-code");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return failure(url.origin, "supabase-not-configured");
  }

  const jar: Cookie[] = [];
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get("cookie")),
      setAll: (cookiesToSet) => {
        // This also carries the expiry of the PKCE verifier, so the jar is
        // applied on the failure paths too — leaving a spent verifier behind
        // makes the next attempt fail for a reason that has nothing to do with
        // the next attempt.
        jar.push(...(cookiesToSet as Cookie[]));
      },
    },
  });

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session || !data.user) {
    return withCookies(failure(url.origin, "exchange-failed"), jar);
  }

  const refreshToken = data.session.provider_refresh_token;
  if (!refreshToken) {
    /*
     * Google omits it when the account has already granted consent and the
     * request did not force the screen. The session is valid, but this
     * application cannot call Drive on their behalf for longer than an hour, so
     * it is a failure to report rather than a detail to skip.
     */
    return withCookies(failure(url.origin, "no-refresh-token"), jar);
  }

  if (!hasServiceRole()) {
    return withCookies(failure(url.origin, "credential-store-unavailable"), jar);
  }

  const credentials = createGoogleCredentials({ table: createSupabaseCredentialTable() });
  await credentials.connect(data.user.id, refreshToken, [...GOOGLE_SCOPES]);

  return withCookies(NextResponse.redirect(`${url.origin}${next}`), jar);
}
