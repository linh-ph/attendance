import { z } from "zod";
import { isAccessError, type AccessErrorCode } from "@/lib/access/policy";
import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/session";
import { createConfigRepository } from "@/lib/config/repository";
import {
  createSetupService,
  isLegacySetupError,
  isSetupError,
  type ExistingFileInspection,
  type LegacySetupErrorCode,
  type MonthlySetupResult,
  type SetupErrorCode,
  type SetupService,
} from "@/lib/files/setup-service";
import { createGoogleGateways } from "@/lib/google/client";
import { FileUnavailableError, FolderUnavailableError } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Legacy attendance file setup.
 *
 * Section 5.3 of the approved design: metadata discovery alone never
 * authorizes a mutation on a file this app did not create. The manager must
 * re-select that exact file in Google Picker, which is what grants `drive.file`
 * access to it, so both handlers require the picked ID to equal the route file
 * ID and refuse everything else before any Google call.
 *
 * The service then re-derives ownership, the current Drive name, and the
 * parent folder under the manager's own identity (section 7.3). `GET` is
 * read-only; `POST` never recreates a tab, and a partially configured file is
 * retained with its IDs so the wizard can resume it (section 9.2).
 */

/* -------------------------------------------------------------------------- */
/* Boundary validation                                                         */
/* -------------------------------------------------------------------------- */

const PICKER_MISMATCH_MESSAGE = "Select this same file in Google Picker to start setup.";
const FOLDER_REQUIRED_MESSAGE = "Select your dashboard folder before setting up this file.";
const INVALID_REQUEST_MESSAGE = "Assign a name and a Google Workspace email to every sheet.";

const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email());

/**
 * Only the mapping table, the month, and the two proof values are accepted. An
 * `ownerEmail` or `fileId` in the body is stripped here: the owner comes from
 * the verified session and the file from the route.
 */
const configureExistingSchema = z.object({
  pickedFileId: z.string().min(1),
  folderId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  mappings: z
    .array(
      z.object({
        sheetId: z.string().trim().regex(/^\d+$/),
        displayName: z.string().trim().min(1),
        email: emailSchema,
      }),
    )
    .min(1),
});

/* -------------------------------------------------------------------------- */
/* Error mapping                                                               */
/* -------------------------------------------------------------------------- */

const ACCESS_ERROR_STATUS: Record<AccessErrorCode, number> = {
  forbidden: 403,
  "needs-setup": 409,
  "needs-repair": 409,
};

const LEGACY_ERROR_STATUS: Record<LegacySetupErrorCode, number> = {
  "duplicate-member-email": 400,
  "duplicate-sheet-mapping": 400,
  "unmapped-employee-sheet": 400,
  "mapping-conflict": 409,
  "member-sheet-missing": 422,
  "file-not-supported": 422,
};

/** Shared setup steps can still fail at the Google boundary. */
const SETUP_ERROR_STATUS: Record<SetupErrorCode, number> = {
  "duplicate-member-email": 400,
  "resume-unavailable": 409,
  "member-sheet-missing": 422,
  "setup-incomplete": 502,
};

function errorJson(message: string, status: number, code?: string): Response {
  return Response.json(
    code === undefined ? { error: message } : { error: message, code },
    { status, headers: NO_STORE },
  );
}

function toErrorResponse(error: unknown): Response {
  const unauthenticated = toApiErrorResponse(error);
  if (unauthenticated) return unauthenticated;

  // `AccessError.reason` is a server diagnostic and is never sent back.
  if (isAccessError(error)) {
    return errorJson(error.message, ACCESS_ERROR_STATUS[error.code], error.code);
  }

  if (isLegacySetupError(error)) {
    return errorJson(error.message, LEGACY_ERROR_STATUS[error.code], error.code);
  }

  if (isSetupError(error)) {
    return errorJson(error.message, SETUP_ERROR_STATUS[error.code], error.code);
  }

  if (error instanceof FileUnavailableError) {
    return errorJson(error.message, 404, error.code);
  }

  if (error instanceof FolderUnavailableError) {
    return errorJson(error.message, 400, error.code);
  }

  return errorJson("Could not set up this attendance file.", 502);
}

/* -------------------------------------------------------------------------- */
/* Response bodies                                                             */
/* -------------------------------------------------------------------------- */

function inspectionBody(inspection: ExistingFileInspection) {
  return {
    file: { id: inspection.fileId, name: inspection.fileName, month: inspection.month },
    folder: inspection.folder,
    sheets: inspection.sheets,
    hasUntrustedConfig: inspection.hasUntrustedConfig,
    members: inspection.members,
  };
}

function setupBody(result: MonthlySetupResult) {
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

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export interface SetupRouteDependencies {
  /** Builds a service bound to the caller's own Google OAuth identity. */
  createService(accessToken: string): Promise<SetupService>;
}

const defaultDependencies: SetupRouteDependencies = {
  async createService(accessToken: string): Promise<SetupService> {
    const { drive, sheets } = createGoogleGateways(accessToken);
    return createSetupService({ drive, sheets, config: createConfigRepository({ sheets, drive }) });
  },
};

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** The Picker grant must be for this same file; a different pick proves nothing. */
function isSameFile(pickedFileId: string | null, fileId: string): boolean {
  return pickedFileId !== null && pickedFileId === fileId;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/files/[fileId]/setup?folderId=…&pickedFileId=…`
 *
 * Reports the employee tabs legacy setup would configure. It reads Drive and
 * Sheets metadata only: nothing about this request mutates the file.
 */
export async function GET(
  request: Request,
  context: RouteContext,
  dependencies: SetupRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId } = await context.params;
    const query = new URL(request.url).searchParams;

    if (!isSameFile(query.get("pickedFileId"), fileId)) {
      return errorJson(PICKER_MISMATCH_MESSAGE, 403, "picker-file-mismatch");
    }

    const folderId = query.get("folderId")?.trim() ?? "";
    if (folderId === "") {
      return errorJson(FOLDER_REQUIRED_MESSAGE, 400, "folder-required");
    }

    const service = await dependencies.createService(session.accessToken);
    const inspection = await service.inspectExisting({
      ownerEmail: session.email,
      fileId,
      folderId,
    });

    return Response.json(inspectionBody(inspection), { status: 200, headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `POST /api/files/[fileId]/setup`
 *
 * Configures an existing attendance workbook: the current schema config, the
 * per-tab protections, and the Drive invitations. The employee tabs themselves
 * are only read, never recreated or resized, so real attendance rows survive.
 * Re-posting the same request resumes a partial attempt.
 */
export async function POST(
  request: Request,
  context: RouteContext,
  dependencies: SetupRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId } = await context.params;

    const parsed = configureExistingSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return errorJson(INVALID_REQUEST_MESSAGE, 400, "invalid-setup-request");
    }

    // Checked before the service is even built, so a mismatched pick cannot
    // reach Drive or Sheets.
    if (!isSameFile(parsed.data.pickedFileId, fileId)) {
      return errorJson(PICKER_MISMATCH_MESSAGE, 403, "picker-file-mismatch");
    }

    const service = await dependencies.createService(session.accessToken);
    const result = await service.configureExisting({
      ownerEmail: session.email,
      fileId,
      folderId: parsed.data.folderId,
      month: parsed.data.month,
      mappings: parsed.data.mappings,
    });

    // A retained file whose invitations partly failed is a partial success:
    // the IDs come back so the wizard can resume it.
    return Response.json(setupBody(result), {
      status: result.complete ? 200 : 207,
      headers: NO_STORE,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
