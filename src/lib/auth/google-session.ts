import { createGoogleCredentials, type GoogleCredentials } from "@/lib/supabase/google-credentials";
import { createSupabaseCredentialTable, hasServiceRole } from "@/lib/supabase/credential-table";
import { createRequestUserReader } from "@/lib/supabase/request-user";
import { googleSessionFromSupabase, type SupabaseUserReader } from "@/lib/supabase/session";
import {
  requireGoogleSessionFromRequest as requireAuthJsSession,
  type GoogleSession,
} from "./session";

/**
 * The one place a route handler asks "who is this, and what may I call Google
 * with?".
 *
 * Two sign-in paths exist while accounts move across: Supabase Auth, which
 * stores the Google refresh token in `google_credentials`, and the original
 * Auth.js cookie, which carries it inside the session JWT. Supabase is asked
 * first; only a request with no Supabase session falls back.
 *
 * **This module is Node-only.** It reaches `node:crypto` to decrypt a stored
 * refresh token, so the Edge proxy must keep importing `./session` — which is
 * exactly why the composition lives here and not there.
 */

let cached: GoogleCredentials | null = null;

function credentials(): GoogleCredentials | null {
  if (!hasServiceRole()) {
    // Supabase may be configured for sign-in before the credential table is
    // reachable. Falling back is correct here; failing would lock everyone out.
    return null;
  }

  cached ??= createGoogleCredentials({ table: createSupabaseCredentialTable() });
  return cached;
}

export interface GoogleSessionDeps {
  readUser?: SupabaseUserReader;
  credentials?: GoogleCredentials | null;
}

export async function requireGoogleSessionFromRequest(
  request: Request,
  deps: GoogleSessionDeps = {},
): Promise<GoogleSession> {
  const google = deps.credentials === undefined ? credentials() : deps.credentials;

  if (google !== null) {
    const session = await googleSessionFromSupabase(request, {
      readUser: deps.readUser ?? createRequestUserReader(),
      credentials: google,
    });

    if (session !== null) {
      return session;
    }
  }

  return requireAuthJsSession(request);
}

export { toApiErrorResponse, UnauthenticatedError } from "./session";
export type { GoogleSession } from "./session";
