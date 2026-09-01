import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/google-session";
import { createPeopleDirectory } from "@/lib/directory/people-directory";
import { createGoogleGateways } from "@/lib/google/client";
import { debugErrorsEnabled, toGoogleErrorDiagnostic } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `GET /api/directory`
 *
 * The colleagues this account can already see, read from the sharing lists of
 * the attendance files it can already open. The actor is always the verified
 * session, never a query parameter, so this cannot be pointed at anybody else's
 * view of Drive.
 *
 * It is a suggestion list and holds no authority: the browser stores what the
 * person keeps, and every file operation re-authorizes on its own.
 */
export async function GET(request: Request): Promise<Response> {
  let accessTokenForRedaction: string | undefined;

  try {
    const session = await requireGoogleSessionFromRequest(request);
    accessTokenForRedaction = session.accessToken;

    const { drive } = createGoogleGateways(session.accessToken);
    const people = await createPeopleDirectory(drive).load(session.email);

    return Response.json({ people }, { headers: NO_STORE });
  } catch (error) {
    const authErrorResponse = toApiErrorResponse(error);
    if (authErrorResponse) return authErrorResponse;

    const debug = debugErrorsEnabled()
      ? toGoogleErrorDiagnostic(error, accessTokenForRedaction ? [accessTokenForRedaction] : [])
      : undefined;
    if (debug) {
      console.error("Directory request failed.", debug);
    }

    return Response.json(
      { error: "Could not read who else can reach your attendance files.", ...(debug ? { debug } : {}) },
      { status: 502, headers: NO_STORE },
    );
  }
}
