import { z } from "zod";
import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/google-session";
import { isAccessError, type AccessErrorCode } from "@/lib/access/policy";
import {
  isAttendanceError,
  readAttendanceMonth,
  saveAttendanceDay,
  type AttendanceDependencies,
  type AttendanceErrorCode,
  type AttendancePatch,
} from "@/lib/attendance/service";
import { createGoogleGateways } from "@/lib/google/client";
import { FileUnavailableError } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Attendance data is per-user and must never be cached by a shared proxy. */
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const;

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export interface AttendanceRouteContext {
  params: Promise<{ fileId: string; sheetId: string }>;
}

export interface AttendanceRouteDependencies {
  createGateways(accessToken: string): Pick<AttendanceDependencies, "drive" | "sheets">;
}

const defaultDependencies: AttendanceRouteDependencies = {
  createGateways: createGoogleGateways,
};

/* -------------------------------------------------------------------------- */
/* Request shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The wire body carries a calendar date and field-keyed patches — never an A1
 * range. Patch contents stay `unknown` here so the service owns the single
 * authoritative rule set for what is an editable cell.
 */
const saveBodySchema = z.object({
  date: z.string().trim().min(1).max(10),
  patches: z.array(z.unknown()).max(64),
});

/* -------------------------------------------------------------------------- */
/* Error mapping                                                               */
/* -------------------------------------------------------------------------- */

const ACCESS_ERROR_STATUS: Record<AccessErrorCode, number> = {
  forbidden: 403,
  "needs-setup": 422,
  "needs-repair": 422,
};

const ATTENDANCE_ERROR_STATUS: Record<AttendanceErrorCode, number> = {
  "invalid-request": 400,
  "invalid-day": 400,
  "sheet-structure": 409,
};

function errorResponse(code: string, message: string, status: number, extra = {}): Response {
  return Response.json({ code, error: message, ...extra }, { status, headers: NO_STORE });
}

/**
 * Maps a failure onto a stable code and English message.
 *
 * A failed save is always answered in place: nothing here redirects, so the
 * browser keeps its unsaved edits (design section 9.2).
 */
function toErrorResponse(error: unknown): Response {
  const unauthenticated = toApiErrorResponse(error);
  if (unauthenticated) return unauthenticated;

  if (isAccessError(error)) {
    // The message is deliberately generic: it never names another member,
    // their sheet, or why the mapping failed.
    return errorResponse(error.code, error.message, ACCESS_ERROR_STATUS[error.code]);
  }

  if (isAttendanceError(error)) {
    return errorResponse(
      error.code,
      error.message,
      ATTENDANCE_ERROR_STATUS[error.code],
      error.issues.length > 0 ? { issues: error.issues } : {},
    );
  }

  if (error instanceof FileUnavailableError) {
    return errorResponse("file-unavailable", "This attendance file is unavailable.", 404);
  }

  return errorResponse("google-unavailable", "Google Sheets could not be reached. Try again.", 502);
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/files/[fileId]/attendance/[sheetId]`
 *
 * The actor is re-derived from the verified session and re-authorized against
 * live Drive metadata and the protected mapping before any attendance value is
 * read. The response carries one member sheet and nothing about any other.
 *
 * The body also carries `spreadsheetTimeZone`: the file's own validated IANA
 * zone, or `null`. It is the only source the client may use to decide `Today`
 * — never UTC, never the browser's zone — and `null` means the client keeps
 * the calendar navigable while disabling `Today`.
 */
export async function handleAttendanceRead(
  request: Request,
  context: AttendanceRouteContext,
  dependencies: AttendanceRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId, sheetId } = await context.params;
    const { drive, sheets } = dependencies.createGateways(session.accessToken);

    const view = await readAttendanceMonth(
      { drive, sheets },
      { fileId, actorEmail: session.email, sheetId },
    );

    return Response.json(view, { status: 200, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `POST /api/files/[fileId]/attendance/[sheetId]`
 *
 * Writes only the cells the client marked dirty, after re-authorizing and
 * re-reading them. Column H keeps its formula. Every failure answers in place
 * so unsaved edits survive.
 */
export async function handleAttendanceSave(
  request: Request,
  context: AttendanceRouteContext,
  dependencies: AttendanceRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId, sheetId } = await context.params;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return errorResponse("invalid-request", "The attendance save request is not valid.", 400);
    }

    const parsed = saveBodySchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse("invalid-request", "The attendance save request is not valid.", 400);
    }

    const { drive, sheets } = dependencies.createGateways(session.accessToken);

    const result = await saveAttendanceDay(
      { drive, sheets },
      {
        fileId,
        actorEmail: session.email,
        sheetId,
        date: parsed.data.date,
        patches: parsed.data.patches as AttendancePatch[],
      },
    );

    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export function GET(request: Request, context: AttendanceRouteContext): Promise<Response> {
  return handleAttendanceRead(request, context);
}

export function POST(request: Request, context: AttendanceRouteContext): Promise<Response> {
  return handleAttendanceSave(request, context);
}
