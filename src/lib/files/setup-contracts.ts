/**
 * The setup service's error types and the shapes its callers depend on.
 *
 * Both Route Handlers map error codes to statuses exhaustively, so the codes
 * live here next to the classes that carry them and nowhere else.
 */

import type { ConfigRepository } from "@/lib/config/repository";
import type { SetupState } from "@/lib/config/schema";
import type { DriveFolder, DriveGateway, SheetsGateway } from "@/lib/google/types";
import type { CreateFileInput } from "./schemas";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SetupErrorCode =
  | "duplicate-member-email"
  | "resume-unavailable"
  | "member-sheet-missing"
  | "setup-incomplete";

export class SetupError extends Error {
  readonly code: SetupErrorCode;

  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

export function isSetupError(value: unknown): value is SetupError {
  return value instanceof SetupError;
}

/**
 * Legacy-setup failures.
 *
 * They are a separate type from `SetupError` on purpose: the create flow and
 * the legacy flow reject different things, and each route maps only its own
 * codes to a status.
 */
export type LegacySetupErrorCode =
  | "duplicate-member-email"
  | "duplicate-sheet-mapping"
  | "unmapped-employee-sheet"
  | "mapping-conflict"
  | "member-sheet-missing"
  | "file-not-supported";

export class LegacySetupError extends Error {
  readonly code: LegacySetupErrorCode;

  constructor(code: LegacySetupErrorCode, message: string) {
    super(message);
    this.name = "LegacySetupError";
    this.code = code;
  }
}

export function isLegacySetupError(value: unknown): value is LegacySetupError {
  return value instanceof LegacySetupError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export const MEMBER_SETUP_STATUSES = ["pending", "ready", "invite-failed"] as const;
export type MemberSetupStatus = (typeof MEMBER_SETUP_STATUSES)[number];

/** Shown next to the member; never carries provider detail. */
export const MEMBER_INVITE_FAILED_MESSAGE = "Could not share this file with this member.";

export interface MemberSetupProgress {
  displayName: string;
  email: string;
  sheetId: string | null;
  sheetTitle: string | null;
  protectionId: string | null;
  permissionId: string | null;
  setupStatus: MemberSetupStatus;
  /** English, member-safe explanation when `setupStatus` is not `ready`. */
  error: string | null;
}

export interface MonthlySetupResult {
  fileId: string;
  fileName: string;
  /** `YYYY-MM`. */
  month: string;
  /** Drive metadata revalidated during this request, not the browser's copy. */
  folder: DriveFolder;
  setupState: SetupState;
  complete: boolean;
  members: MemberSetupProgress[];
}

export interface CreateMonthlyFileInput {
  /** Normalized verified session email. A client-supplied owner is never used. */
  ownerEmail: string;
  request: CreateFileInput;
  /** Resume an already-created, partially configured file instead of creating one. */
  resumeFileId?: string;
}

export interface SetupServiceDependencies {
  drive: DriveGateway;
  sheets: SheetsGateway;
  config: ConfigRepository;
}

/** One existing tab the manager assigned to one employee. */
export interface ExistingSheetMapping {
  /** Numeric Google sheet ID of a tab that already exists, as a string. */
  sheetId: string;
  displayName: string;
  email: string;
}

export interface InspectExistingFileInput {
  /** Normalized verified session email. A client-supplied owner is never used. */
  ownerEmail: string;
  fileId: string;
  /** The manager's active dashboard folder; the file must be a direct child. */
  folderId: string;
}

export interface ConfigureExistingFileInput extends InspectExistingFileInput {
  /** `YYYY-MM`; used only when this file has no readable configuration yet. */
  month: string;
  mappings: readonly ExistingSheetMapping[];
}

export interface ExistingSheet {
  sheetId: string;
  title: string;
}

export interface ExistingFileInspection {
  fileId: string;
  /** The current Drive name, never the browser's copy. */
  fileName: string;
  folder: DriveFolder;
  /** From this app's configuration, else the Drive property, else `null`. */
  month: string | null;
  /** Every tab except `__APP_CONFIG`, in workbook order. */
  sheets: ExistingSheet[];
  /** A configuration sheet exists that this app cannot read and will replace. */
  hasUntrustedConfig: boolean;
  /** Progress retained by an earlier attempt; empty when there is none. */
  members: MemberSetupProgress[];
}

export interface SetupService {
  create(input: CreateMonthlyFileInput): Promise<MonthlySetupResult>;
  /** Read-only: reports what legacy setup would configure. Mutates nothing. */
  inspectExisting(input: InspectExistingFileInput): Promise<ExistingFileInspection>;
  configureExisting(input: ConfigureExistingFileInput): Promise<MonthlySetupResult>;
}
