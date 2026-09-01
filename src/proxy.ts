import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { createProxy, type AuthenticatedProxy } from "@/lib/auth/proxy";
import { isSupabaseConfigured, refreshSupabaseSession } from "@/lib/supabase/middleware";

const authenticatedProxy = auth as unknown as AuthenticatedProxy;

/**
 * One proxy, two sessions.
 *
 * Auth.js still decides whether the request may proceed — it holds the Google
 * credentials every Drive and Sheets call runs on. Supabase's session is
 * refreshed alongside it so that, where Supabase is configured, its cookie does
 * not silently expire.
 *
 * The refresh runs first and its cookies are discarded when Auth.js redirects,
 * which is correct: a request being sent to sign in has no session to keep
 * fresh. Where Supabase is not configured this is a no-op, so the app runs
 * unchanged without it.
 */
async function refreshThenAuthorize(
  request: NextRequest,
): Promise<Response | null | undefined> {
  if (isSupabaseConfigured()) {
    await refreshSupabaseSession(request);
  }

  return authenticatedProxy(request);
}

export const proxy = createProxy(refreshThenAuthorize);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
