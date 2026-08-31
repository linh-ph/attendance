import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/session";
import { createConfigRepository } from "@/lib/config/repository";
import { createFileInputSchema } from "@/lib/files/schemas";
import {
  createSetupService,
  isSetupError,
  type MonthlySetupResult,
  type SetupErrorCode,
} from "@/lib/files/setup-service";
import { createGoogleGateways } from "@/lib/google/client";
import {
  FolderUnavailableError,
  debugErrorsEnabled,
  toGoogleErrorDiagnostic,
} from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Setup failures the caller can act on. Anything else is a Google boundary
 * problem and answers 502 rather than blaming the request.
 */
const SETUP_ERROR_STATUS: Record<SetupErrorCode, number> = {
  "duplicate-member-email": 400,
  "resume-unavailable": 409,
  "member-sheet-missing": 422,
  "setup-incomplete": 502,
};

function toResponseBody(result: MonthlySetupResult) {
  return {
    file: {
      id: result.fileId,
      name: result.fileName,
      month: result.month,
      setupState: result.setupState,
      complete: result.complete,
    },
    folder: result.folder,
    members: result.members,
  };
}

/**
 * `POST /api/files/create`
 *
 * Creates one monthly attendance file in the manager's own Drive folder.
 *
 * The owner is always the verified session identity; an `ownerEmail` in the
 * body is stripped by the schema and never reaches the service. Validation
 * runs before any Google call, so a rejected request creates nothing. A
 * partially configured file is retained and answered with 207 plus its IDs so
 * the wizard can resume it — it is never deleted as rollback.
 */
export async function POST(request: Request): Promise<Response> {
  let accessTokenForRedaction: string | undefined;

  try {
    const session = await requireGoogleSessionFromRequest(request);
    accessTokenForRedaction = session.accessToken;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { error: "Send a valid JSON request body." },
        { status: 400, headers: NO_STORE },
      );
    }

    const parsed = createFileInputSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json(
        { error: "Check the file name, month, folder, and members." },
        { status: 400, headers: NO_STORE },
      );
    }

    const { drive, sheets } = createGoogleGateways(session.accessToken);
    const service = createSetupService({
      drive,
      sheets,
      config: createConfigRepository({ sheets, drive }),
    });

    const result = await service.create({
      ownerEmail: session.email,
      request: parsed.data,
    });

    return Response.json(toResponseBody(result), {
      status: result.complete ? 201 : 207,
      headers: NO_STORE,
    });
  } catch (error) {
    const unauthenticated = toApiErrorResponse(error);
    if (unauthenticated) return unauthenticated;

    if (isSetupError(error)) {
      return Response.json(
        { error: error.message },
        { status: SETUP_ERROR_STATUS[error.code], headers: NO_STORE },
      );
    }

    if (error instanceof FolderUnavailableError) {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }

    /*
     * Everything above is a failure the caller can act on. What is left is the
     * Google boundary, and without this the wizard says only "Could not create
     * the attendance file" — true, and useless for finding out why. Matches
     * `/api/dashboard` and `/api/directory`, which already report this way.
     */
    const debug = debugErrorsEnabled()
      ? toGoogleErrorDiagnostic(error, accessTokenForRedaction ? [accessTokenForRedaction] : [])
      : undefined;
    if (debug) {
      console.error("Create attendance file failed.", debug);
    }

    return Response.json(
      { error: "Could not create the attendance file.", ...(debug ? { debug } : {}) },
      { status: 502, headers: NO_STORE },
    );
  }
}
