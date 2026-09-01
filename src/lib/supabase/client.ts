import { createBrowserClient } from "@supabase/ssr";

/**
 * The Supabase client for browser code.
 *
 * Same publishable key as the server helper, and the same rule: it grants
 * nothing on its own, and everything it can reach is decided by Row Level
 * Security. Never put a service role key here — this bundle ships to the
 * browser.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function createClient() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseKey);
}
