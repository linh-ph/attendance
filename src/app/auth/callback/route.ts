import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createGoogleCredentials } from "@/lib/supabase/google-credentials";
import { createSupabaseCredentialTable, hasServiceRole } from "@/lib/supabase/credential-table";
import { createClient } from "@/lib/supabase/server";
import { GOOGLE_SCOPES } from "@/auth.config";

/**
 * Where Supabase returns after Google consent.
 *
 * This is the **only** moment Google hands over a refresh token: it comes back
 * once, on this exchange, and never again for the same grant. Supabase does not
 * keep it and does not refresh the Google token afterwards, so if it is not
 * stored here the person's Drive and Sheets access dies about an hour later and
 * only another consent screen can revive it. Hence the failure handling below —
 * a lost token is reported, never swallowed.
 */

const SIGNED_IN_AT = "/dashboard";

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

  const supabase = createClient(await cookies());
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session || !data.user) {
    return failure(url.origin, "exchange-failed");
  }

  const refreshToken = data.session.provider_refresh_token;
  if (!refreshToken) {
    /*
     * Google omits it when the account has already granted consent and the
     * request did not force the screen. The session is valid, but this
     * application cannot call Drive on their behalf for longer than an hour, so
     * it is a failure to report rather than a detail to skip.
     */
    return failure(url.origin, "no-refresh-token");
  }

  if (!hasServiceRole()) {
    return failure(url.origin, "credential-store-unavailable");
  }

  const credentials = createGoogleCredentials({ table: createSupabaseCredentialTable() });
  await credentials.connect(data.user.id, refreshToken, [...GOOGLE_SCOPES]);

  return NextResponse.redirect(`${url.origin}${next}`);
}
