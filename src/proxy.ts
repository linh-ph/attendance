import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { createProxy, type AuthenticatedProxy } from "@/lib/auth/proxy";
import { isSupabaseConfigured, refreshSupabaseSession } from "@/lib/supabase/middleware";

const authenticatedProxy = auth as unknown as AuthenticatedProxy;

/**
 * One proxy, two sessions.
 *
 * Either sign-in path admits a request, because both are live while accounts
 * move across. Supabase is asked first — its answer costs a token
 * revalidation that is happening anyway to keep the cookie fresh — and a
 * request it recognizes is let through with that refreshed response, cookies
 * and all. Only a request Supabase does not recognize reaches Auth.js.
 *
 * The order matters the other way round too: were Auth.js asked first, a person
 * who has moved to Supabase would be redirected to `/login` while holding a
 * perfectly valid session.
 *
 * Where Supabase is not configured this is a no-op and the app runs unchanged.
 */
async function refreshThenAuthorize(
  request: NextRequest,
): Promise<Response | null | undefined> {
  if (!isSupabaseConfigured()) {
    return authenticatedProxy(request);
  }

  const { response, userId, diagnostic } = await refreshSupabaseSession(request);
  if (userId !== null) {
    return response;
  }

  const fallback = await authenticatedProxy(request);
  if (fallback instanceof Response) {
    fallback.headers.set("x-supabase-session", diagnostic);
  }

  return fallback;
}

export const proxy = createProxy(refreshThenAuthorize);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
