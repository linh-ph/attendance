/**
 * Per-request file authorization.
 *
 * Implements the defense-in-depth check from section 7.3 of the approved
 * design: every call re-reads current Drive ownership metadata and the
 * protected sheet-native mapping, and never trusts a client-supplied email, a
 * cached role, or a sheet title.
 *
 * A missing mapping is surfaced as `Needs setup` / `Needs repair` rather than
 * degrading into a silent match, per section 9.2.
 */

import {
  ConfigMissingError,
  isConfigRepositoryError,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import { isAppConfigError, normalizeEmail, type ConfigMember } from "@/lib/config/schema";
import { FileUnavailableError } from "@/lib/google/errors";
import type { DriveFileAccess, DriveGateway, SheetSummary } from "@/lib/google/types";

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

/** The file (or the actor's member row) has not been configured yet. */
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
  | { kind: "employee"; email: string; sheetId: string; sheetTitle: string };

export interface AccessDependencies {
  drive: DriveGateway;
  config: ConfigRepository;
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

async function readConfig(
  dependencies: AccessDependencies,
  fileId: string,
): Promise<ConfigReadResult> {
  try {
    return await dependencies.config.read(fileId);
  } catch (error) {
    if (error instanceof ConfigMissingError) {
      throw new NeedsSetupError("config-sheet-missing");
    }
    if (isConfigRepositoryError(error)) {
      throw new NeedsRepairError(`config-repository:${error.code}`);
    }
    if (isAppConfigError(error)) {
      throw new NeedsRepairError(`config-unreadable:${error.code}`);
    }
    throw error;
  }
}

function findSheet(sheets: SheetSummary[], sheetId: string): SheetSummary | undefined {
  return sheets.find((sheet) => String(sheet.sheetId) === sheetId);
}

function resolveEmployeeSheet(member: ConfigMember, sheets: SheetSummary[]): SheetSummary {
  if (member.sheetId === null) {
    throw new NeedsSetupError("member-sheet-not-mapped");
  }

  const sheet = findSheet(sheets, member.sheetId);
  if (!sheet) {
    // Never fall back to matching by title: the sheet ID is the identity key.
    throw new NeedsRepairError("member-sheet-missing");
  }

  if (member.protectionId === null) {
    throw new NeedsRepairError("member-protection-not-recorded");
  }

  const hasProtection = sheet.protectedRanges.some(
    (range) => String(range.protectedRangeId) === member.protectionId,
  );
  if (!hasProtection) {
    throw new NeedsRepairError("member-protection-missing");
  }

  return sheet;
}

export async function authorizeFile(
  dependencies: AccessDependencies,
  request: AuthorizeFileRequest,
): Promise<FileRole> {
  const actorEmail = normalizeEmail(request.actorEmail);
  if (actorEmail === "") {
    throw new ForbiddenError("missing-actor-email");
  }

  // Step 2: current Drive ownership/access metadata, never a cached role.
  const access = await dependencies.drive.getFileAccess(request.fileId);
  if (access.trashed) {
    throw new FileUnavailableError("trashed");
  }

  if (isCurrentOwner(access, actorEmail)) {
    return { kind: "manager", email: actorEmail };
  }

  // Step 3: the protected mapping decides every non-owner request.
  const { config, spreadsheet } = await readConfig(dependencies, request.fileId);

  const member = config.members.find((candidate) => candidate.email === actorEmail);
  if (!member) {
    throw new ForbiddenError("actor-not-configured");
  }

  const sheet = resolveEmployeeSheet(member, spreadsheet.sheets);
  const sheetId = String(sheet.sheetId);

  // Step 4/5: an employee may only address their own mapped sheet.
  if (request.requestedSheetId !== undefined && request.requestedSheetId !== sheetId) {
    throw new ForbiddenError("requested-sheet-not-mapped");
  }

  return {
    kind: "employee",
    email: actorEmail,
    sheetId,
    // The live title wins so a renamed tab stays addressable by ID.
    sheetTitle: sheet.title,
  };
}
