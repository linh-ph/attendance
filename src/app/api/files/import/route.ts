import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/google-session";
import { createConfigRepository } from "@/lib/config/repository";
import {
  assertDeclaredSizeWithinLimit,
  parseImportFields,
  readMultipartForm,
  readResumeFileId,
  readWorkbookUpload,
} from "@/lib/files/import-schemas";
import {
  createImportService,
  isImportError,
  type ImportErrorCode,
  type ImportResult,
} from "@/lib/files/import-service";
import { createGoogleGateways } from "@/lib/google/client";
import { FolderUnavailableError } from "@/lib/google/errors";
import { WorkbookCheckError } from "@/lib/workbook/xlsx-inspector";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Import failures the caller can act on. Anything else is a Google boundary
 * problem and answers 502 rather than blaming the request.
 */
const IMPORT_ERROR_STATUS: Record<ImportErrorCode, number> = {
  "duplicate-member-email": 400,
  "sheet-mapping-mismatch": 400,
  "resume-unavailable": 409,
  "member-sheet-missing": 422,
  "setup-incomplete": 502,
};

/**
 * The partial-failure contract: the converted file, the folder the browser must
 * activate, and one status per member so a single failed invitation can be
 * retried on its own.
 */
function toResponseBody(result: ImportResult) {
  return {
    fileId: result.fileId,
    folder: result.folder,
    setupState: result.setupState,
    retryable: result.retryable,
    members: result.members.map((member) => ({
      email: member.email,
      setupStatus: member.setupStatus,
    })),
  };
}

/**
 * `POST /api/files/import`
 *
 * Converts an uploaded `.xlsx` workbook into one Google Sheets attendance file
 * in the manager's own Drive folder.
 *
 * Every check runs again here against the original bytes, because the browser's
 * earlier inspection is not authority: a rejected request converts nothing. The
 * owner is always the verified session identity, and the stored sheet titles
 * come from the workbook rather than from this payload. A partially configured
 * file is retained and answered with 207 plus its ID and folder so the wizard
 * can resume it — it is never deleted as rollback.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);

    assertDeclaredSizeWithinLimit(request);
    const form = await readMultipartForm(request);
    const workbook = await readWorkbookUpload(form);

    const parsed = parseImportFields(form);
    if (parsed === null) {
      return Response.json(
        {
          error: "Check the output file name, month, folder, and sheet mappings.",
          code: "invalid-import-request",
        },
        { status: 400, headers: NO_STORE },
      );
    }

    const { drive, sheets } = createGoogleGateways(session.accessToken);
    const service = createImportService({
      drive,
      sheets,
      config: createConfigRepository({ sheets, drive }),
    });

    const result = await service.importWorkbook({
      ownerEmail: session.email,
      request: parsed,
      workbook,
      resumeFileId: readResumeFileId(form),
    });

    return Response.json(toResponseBody(result), {
      status: result.complete ? 201 : 207,
      headers: NO_STORE,
    });
  } catch (error) {
    const unauthenticated = toApiErrorResponse(error);
    if (unauthenticated) return unauthenticated;

    if (error instanceof WorkbookCheckError) {
      return Response.json(
        { error: error.message, code: error.code, sheetTitle: error.sheetTitle },
        { status: 400, headers: NO_STORE },
      );
    }

    if (isImportError(error)) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: IMPORT_ERROR_STATUS[error.code], headers: NO_STORE },
      );
    }

    if (error instanceof FolderUnavailableError) {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }

    return Response.json(
      { error: "Could not import the attendance file." },
      { status: 502, headers: NO_STORE },
    );
  }
}
