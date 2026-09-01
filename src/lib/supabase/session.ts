import { UnauthenticatedError, type GoogleSession } from "@/lib/auth/session";
import { GoogleCredentialError, type GoogleCredentials } from "./google-credentials";

/**
 * Resolving a request to a Google session through Supabase Auth.
 *
 * Auth.js carried the Google credential inside the session cookie itself, so a
 * request either had a usable token or was unauthenticated, and there was no
 * third case. Supabase splits that: the cookie proves *who* the person is, and
 * the Google credential is a separate row this application holds. So there are
 * now three outcomes, and conflating any two of them misleads the person:
 *
 *   session + credential   → a live access token
 *   no session             → `null`, so the caller falls back to Auth.js
 *   session, no credential → refusal; they must grant Google access again
 *
 * The `null` case exists only while both sign-in paths do. Once every account
 * has moved to Supabase, the fallback in `requireGoogleSessionFromRequest` can
 * go and this returns a session or throws.
 */

export type SupabaseAuthUser = {
  id: string;
  email?: string | null;
};

export type SupabaseUserReader = (request: Request) => Promise<SupabaseAuthUser | null>;

export interface SupabaseSessionDeps {
  readUser: SupabaseUserReader;
  credentials: GoogleCredentials;
}

export async function googleSessionFromSupabase(
  request: Request,
  { readUser, credentials }: SupabaseSessionDeps,
): Promise<GoogleSession | null> {
  const user = await readUser(request);
  if (user === null) {
    return null;
  }

  const email = user.email?.trim().toLowerCase();
  if (!email) {
    /*
     * Every downstream authorization decision is keyed on the normalized email
     * — a Supabase user without one cannot be matched to a workbook member, so
     * proceeding would silently authorize against nobody.
     */
    throw new UnauthenticatedError();
  }

  try {
    return { email, accessToken: await credentials.accessTokenFor(user.id) };
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      // Both codes mean the same thing to the person: grant Google access
      // again. A storage outage is deliberately not caught here — reporting it
      // as "sign in again" would loop them through consent without fixing it.
      throw new UnauthenticatedError();
    }

    throw error;
  }
}
