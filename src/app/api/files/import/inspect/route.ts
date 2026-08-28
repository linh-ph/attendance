import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/session";
import {
  assertDeclaredSizeWithinLimit,
  readMultipartForm,
  readWorkbookUpload,
} from "@/lib/files/import-schemas";
import { WorkbookCheckError, inspectXlsx } from "@/lib/workbook/xlsx-inspector";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `POST /api/files/import/inspect`
 *
 * Recognizes the sheets of an uploaded `.xlsx` workbook and reports each one's
 * title, row count, and month so the manager can confirm the output name,
 * month, and one email per sheet before anything is uploaded to Google.
 *
 * This endpoint mutates nothing and never calls Drive or Sheets: it only reads
 * the upload. It still requires a session, because inspection is a product
 * feature rather than a public parser.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireGoogleSessionFromRequest(request);

    assertDeclaredSizeWithinLimit(request);
    const form = await readMultipartForm(request);
    const workbook = await readWorkbookUpload(form);

    return Response.json(await inspectXlsx(workbook), { status: 200, headers: NO_STORE });
  } catch (error) {
    const unauthenticated = toApiErrorResponse(error);
    if (unauthenticated) return unauthenticated;

    if (error instanceof WorkbookCheckError) {
      return Response.json(
        { error: error.message, code: error.code, sheetTitle: error.sheetTitle },
        { status: 400, headers: NO_STORE },
      );
    }

    return Response.json(
      { error: "Could not read this workbook." },
      { status: 400, headers: NO_STORE },
    );
  }
}
