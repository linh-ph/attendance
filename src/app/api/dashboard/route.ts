import { z } from "zod";
import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/google-session";
import { createFileDiscovery, type FolderError } from "@/lib/discovery/file-discovery";
import { createGoogleGateways } from "@/lib/google/client";
import { debugErrorsEnabled, toGoogleErrorDiagnostic } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const folderIdSchema = z.string().trim().min(1).max(256);

/**
 * Folder reasons that mean "gone", "not yours", and "not a usable folder".
 * The browser uses the status to decide whether to drop its remembered folder;
 * the reason itself stays server-side.
 */
const FOLDER_ERROR_STATUS: Record<string, number> = {
  "not-found": 404,
  "not-owned": 403,
  "not-writable": 403,
  "shared-drive": 403,
};

function folderErrorStatus(folderError: FolderError): number {
  return FOLDER_ERROR_STATUS[folderError.reason] ?? 422;
}

/**
 * `GET /api/dashboard?folderId=...`
 *
 * The actor is always re-derived from the session; any `email` query parameter
 * a client sends is ignored. The remembered folder ID is revalidated by Drive
 * on every request, and a bad folder never suppresses the employee section.
 */
export async function GET(request: Request): Promise<Response> {
  let accessTokenForRedaction: string | undefined;

  try {
    const session = await requireGoogleSessionFromRequest(request);
    accessTokenForRedaction = session.accessToken;

    const rawFolderId = new URL(request.url).searchParams.get("folderId");
    let folderId: string | null = null;

    if (rawFolderId !== null) {
      const parsed = folderIdSchema.safeParse(rawFolderId);
      if (!parsed.success) {
        return Response.json(
          { error: "Select a folder before continuing." },
          { status: 400, headers: NO_STORE },
        );
      }
      folderId = parsed.data;
    }

    const { drive, sheets } = createGoogleGateways(session.accessToken);
    // No configuration repository: discovery reads Drive metadata and tab lists.
    const discovery = createFileDiscovery({ drive, sheets });

    const dashboard = await discovery.load({ actorEmail: session.email, folderId });

    return Response.json(
      {
        folder: dashboard.folder,
        managed: dashboard.managed,
        timesheets: dashboard.timesheets,
        /*
         * Files this actor can see but whose contents could not be read this
         * request. Sent so the browser can say "Google Sheets could not be
         * reached" instead of "you have no timesheets" — two states that used
         * to be the same empty list. Only the ID and name Drive already gave
         * this actor cross the wire; the provider error stays server-side.
         */
        unreadable: dashboard.unreadable,
        ...(dashboard.folderError ? { folderError: dashboard.folderError.message } : {}),
      },
      {
        status: dashboard.folderError ? folderErrorStatus(dashboard.folderError) : 200,
        headers: NO_STORE,
      },
    );
  } catch (error) {
    const authErrorResponse = toApiErrorResponse(error);
    if (authErrorResponse) return authErrorResponse;

    const debug = debugErrorsEnabled()
      ? toGoogleErrorDiagnostic(error, accessTokenForRedaction ? [accessTokenForRedaction] : [])
      : undefined;
    if (debug) {
      console.error("Dashboard request failed.", debug);
    }

    return Response.json(
      {
        error: "Could not load your dashboard.",
        ...(debug ? { debug } : {}),
      },
      { status: 502, headers: NO_STORE },
    );
  }
}
