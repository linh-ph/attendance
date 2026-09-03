import { cookies } from "next/headers";
import { auth } from "@/auth";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/request-user";

/**
 * Who is signed in, for a server component.
 *
 * The page counterpart of `google-session.ts`, which serves route handlers.
 * Pages have no `Request`, so this reads the cookie store instead — but it must
 * answer for **both** sign-in paths, and that is not a detail:
 *
 * Every page used to call Auth.js directly. Once sign-in moved to Supabase the
 * proxy admitted the request, the API served it, and then the page itself
 * redirected to `/login` — a bounce that looked exactly like a broken session
 * while every server-side sign of success was present. A page that asks only
 * one of the two providers is the bug, not a simplification.
 *
 * Identity only. No page authorizes anything with this: every route and every
 * mutation re-authorizes against Drive on the signed-in person's own
 * credentials.
 */

function normalized(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

export async function currentUserEmail(): Promise<string | null> {
  if (isSupabaseConfigured()) {
    try {
      const { data } = await createClient(await cookies()).auth.getUser();
      const email = normalized(data.user?.email);
      if (email) {
        return email;
      }
    } catch {
      /*
       * A Supabase outage must not lock out the accounts that still sign in
       * through Auth.js, so this falls through rather than failing the page.
       * The request is re-authorized against Drive regardless of which path
       * answered here.
       */
    }
  }

  return normalized((await auth())?.user?.email);
}
