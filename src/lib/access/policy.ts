/**
 * Per-request file authorization, from Drive metadata alone.
 *
 * Every call re-reads current Drive ownership and never trusts a
 * client-supplied email or a cached role. It no longer reads `__APP_CONFIG`:
 * see `authorizeFile` below and
 * `docs/decisions/2026-08-29-app-is-a-sheets-client.md`.
 */

import { normalizeEmail } from "@/lib/config/schema";
import { FileUnavailableError } from "@/lib/google/errors";
import type { DriveFileAccess, DriveGateway } from "@/lib/google/types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AccessErrorCode = "forbidden" | "needs-setup" | "needs-repair";

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  /** Server-side diagnostic. Safe to log; never rendered to another actor. */
  readonly reason: string;

  constructor(code: AccessErrorCode, message: string, reason: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * The actor may not address the requested file or sheet.
 *
 * The message and every own property are deliberately free of any other
 * member's email, display name, sheet title, or sheet ID.
 */
export class ForbiddenError extends AccessError {
  constructor(reason: string = "not-authorized") {
    super("forbidden", "You do not have access to this attendance sheet.", reason);
    this.name = "ForbiddenError";
  }
}

/**
 * The file has not been set up yet.
 *
 * `authorizeFile` no longer raises this — it does not read the configuration
 * sheet at all. It is still raised by the manager-side setup, import, and
 * member services, which do write that sheet.
 */
export class NeedsSetupError extends AccessError {
  constructor(reason: string) {
    super("needs-setup", "This attendance file needs setup.", reason);
    this.name = "NeedsSetupError";
  }
}

/** The file is configured but its mapping, sheet, or protection is broken. */
export class NeedsRepairError extends AccessError {
  constructor(reason: string) {
    super("needs-repair", "This attendance file needs repair.", reason);
    this.name = "NeedsRepairError";
  }
}

export function isAccessError(value: unknown): value is AccessError {
  return value instanceof AccessError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export type FileRole =
  | { kind: "manager"; email: string }
  /**
   * Everyone who is not the current owner. There is no mapping to restrict
   * against, so Google's own sharing is the only boundary — which is the
   * boundary the person already has when they open the file in Google Sheets.
   * The requested tab is passed through unchanged.
   */
  | { kind: "open"; email: string; sheetId: string | null };

export interface AccessDependencies {
  drive: DriveGateway;
}

export interface AuthorizeFileRequest {
  fileId: string;
  /** Normalized server-session email. Never a client-supplied value. */
  actorEmail: string;
  /** Numeric sheet ID from the route, as a string. */
  requestedSheetId?: string;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

function isCurrentOwner(access: DriveFileAccess, actorEmail: string): boolean {
  if (access.ownedByMe !== true) return false;
  const ownerEmail = access.ownerEmail === null ? null : normalizeEmail(access.ownerEmail);
  return ownerEmail !== null && ownerEmail === actorEmail;
}

/**
 * Decides what the signed-in account may do with one file.
 *
 * It reads **Drive metadata and nothing else**. `__APP_CONFIG` used to be
 * consulted here to resolve a member to their mapped tab and to refuse every
 * other tab; that check is gone. It never protected anything — every real
 * workbook was measured with `protectedRanges: []`, so the same edit was always
 * one click away in Google Sheets — while it did refuse people whose files had
 * no configuration, which is all of them.
 *
 * What still holds, and is the whole of the boundary:
 *
 * - every call runs on the signed-in user's own Google credentials, so nobody
 *   can do anything Google would refuse;
 * - the actor email comes from the verified server session, never the client;
 * - live Drive access is re-read on every request, never a cached role.
 *
 * See `docs/decisions/2026-08-29-app-is-a-sheets-client.md`.
 */
export async function authorizeFile(
  dependencies: AccessDependencies,
  request: AuthorizeFileRequest,
): Promise<FileRole> {
  const actorEmail = normalizeEmail(request.actorEmail);
  if (actorEmail === "") {
    throw new ForbiddenError("missing-actor-email");
  }

  // Current Drive ownership/access metadata, never a cached role.
  const access = await dependencies.drive.getFileAccess(request.fileId);
  if (access.trashed) {
    throw new FileUnavailableError("trashed");
  }

  if (isCurrentOwner(access, actorEmail)) {
    return { kind: "manager", email: actorEmail };
  }

  return { kind: "open", email: actorEmail, sheetId: request.requestedSheetId ?? null };
}
