"use server";

import { cookies } from "next/headers";
import { signOut } from "@/auth";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/request-user";

/**
 * The one sign-out action.
 *
 * Both shells offer Sign out — the sidebar foot on desktop, the `More` page on
 * a phone — and both must end the session the same way, so the action is
 * defined once here rather than inlined at each call site.
 *
 * **Both sessions are ended, not whichever one signed the person in.** The API
 * accepts either, so clearing only one would leave `Sign out` looking like it
 * worked while the other still admits every request — the worst possible
 * outcome on a shared machine. Ending a session that was never started is
 * harmless; ending only one is not.
 *
 * Supabase goes first: `signOut` from Auth.js throws a redirect, and anything
 * after it would never run.
 */
export async function signOutAction(): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      await createClient(await cookies()).auth.signOut();
    } catch {
      /*
       * A Supabase outage must not trap someone in a session they asked to
       * leave. The local cookies are cleared regardless by `signOut`'s own
       * cookie writes, and the Auth.js sign-out below still runs.
       */
    }
  }

  await signOut({ redirectTo: "/" });
}
