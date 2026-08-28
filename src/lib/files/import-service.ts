/**
 * Retryable `.xlsx` import and Google Sheets conversion.
 *
 * The service composes the Drive/Sheets gateways, the sheet-native config
 * repository, and the pure workbook inspector into the import flow of section
 * 8.2 of the approved design:
 *
 * 1. validate the request and every sheet mapping against the original bytes,
 *    before Drive is touched at all;
 * 2. revalidate the destination folder immediately before the upload;
 * 3. convert the unmodified bytes into the folder under the manager's identity;
 * 4. record `pending` so a half-configured file is still discoverable;
 * 5. replace the untrusted uploaded `__APP_CONFIG` with the current schema;
 * 6. reconcile the mapped tabs and add their protections;
 * 7. invite one unique employee email at a time — Drive does not support
 *    concurrent permission changes on one file;
 * 8. mark `ready`, or `needs-repair` with per-member progress retained.
 *
 * A converted file is never deleted as rollback (section 9.2). A failed attempt
 * returns the file ID, the revalidated folder, and per-member progress so the
 * browser can resume with `resumeFileId` — a resume never uploads again.
 *
 * Reconciliation invariant: imported tabs already contain real attendance rows,
 * so the service only *reads* their numeric IDs and protects them. It never
 * replays the fresh-tab template, whose grid resize would truncate those rows.
 */

import { STATUS_OPTIONS } from "@/lib/attendance/model";
import {
  ConfigMissingError,
  buildAppProperties,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import {
  normalizeEmail,
  type ConfigMember,
  type ConfigStatus,
  type SetupState,
} from "@/lib/config/schema";
import type {
  DriveFolder,
  DriveGateway,
  SheetRequest,
  SheetsGateway,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import { TEMPLATE_VERSION } from "@/lib/workbook/template";
import { WorkbookCheckError, inspectXlsx } from "@/lib/workbook/xlsx-inspector";
import type { ImportFileInput } from "./import-schemas";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ImportErrorCode =
  | "duplicate-member-email"
  | "sheet-mapping-mismatch"
  | "resume-unavailable"
  | "member-sheet-missing"
  | "setup-incomplete";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export const IMPORT_MEMBER_SETUP_STATUSES = ["pending", "ready", "invite-failed"] as const;
export type ImportMemberSetupStatus = (typeof IMPORT_MEMBER_SETUP_STATUSES)[number];

/** Shown next to the member; never carries provider detail. */
export const IMPORT_MEMBER_INVITE_FAILED_MESSAGE =
  "Could not share this file with this member.";

const EMPLOYEE_PROTECTION_DESCRIPTION = "Attendance employee sheet";

export interface ImportMemberProgress {
  displayName: string;
  email: string;
  sheetId: string | null;
  sheetTitle: string | null;
  protectionId: string | null;
  permissionId: string | null;
  setupStatus: ImportMemberSetupStatus;
  /** English, member-safe explanation when `setupStatus` is not `ready`. */
  error: string | null;
}

export interface ImportResult {
  fileId: string;
  fileName: string;
  /** `YYYY-MM`, the manager-confirmed month. */
  month: string;
  /** Drive metadata revalidated during this request, not the browser's copy. */
  folder: DriveFolder;
  setupState: SetupState;
  complete: boolean;
  /** The converted file is retained and the request can be resumed as-is. */
  retryable: boolean;
  members: ImportMemberProgress[];
}

export interface ImportWorkbookInput {
  /** Normalized verified session email. A client-supplied owner is never used. */
  ownerEmail: string;
  request: ImportFileInput;
  /** The unmodified uploaded workbook bytes. */
  workbook: Uint8Array;
  /** Resume an already-converted, partially configured file instead of uploading. */
  resumeFileId?: string;
}

export interface ImportServiceDependencies {
  drive: DriveGateway;
  sheets: SheetsGateway;
  config: ConfigRepository;
}

export interface ImportService {
  importWorkbook(input: ImportWorkbookInput): Promise<ImportResult>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_STATUSES: ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

interface PlannedMember {
  displayName: string;
  email: string;
  /** Always the workbook's own sheet title; never a client-supplied name. */
  title: string;
}

interface EmployeeTab extends PlannedMember {
  sheetId: number;
}

/**
 * Validates the confirmed month, the sheet-to-email bijection, and email
 * uniqueness against the inspected workbook, before any Google call.
 */
async function planMembers(
  workbook: Uint8Array,
  request: ImportFileInput,
): Promise<PlannedMember[]> {
  const inspection = await inspectXlsx(workbook);

  for (const sheet of inspection.sheets) {
    if (sheet.month !== request.month) {
      throw new WorkbookCheckError(
        "month-mismatch",
        `The dates in this sheet belong to ${sheet.month}, not the selected month ${request.month}.`,
        sheet.title,
      );
    }
  }

  const byTitle = new Map(request.mappings.map((mapping) => [mapping.sheetTitle, mapping]));

  if (byTitle.size !== request.mappings.length || byTitle.size !== inspection.sheets.length) {
    throw new ImportError(
      "sheet-mapping-mismatch",
      "Assign exactly one employee email to every sheet in this workbook.",
    );
  }

  const seen = new Set<string>();

  return inspection.sheets.map((sheet) => {
    const mapping = byTitle.get(sheet.title);
    if (mapping === undefined) {
      throw new ImportError(
        "sheet-mapping-mismatch",
        `Sheet "${sheet.title}" has no employee email assigned to it.`,
      );
    }

    const email = normalizeEmail(mapping.email);
    if (seen.has(email)) {
      throw new ImportError(
        "duplicate-member-email",
        `Member email "${email}" is listed more than once.`,
      );
    }
    seen.add(email);

    return {
      displayName: mapping.displayName?.trim() || sheet.title,
      email,
      title: sheet.title,
    };
  });
}

function toMemberStatus(value: string): ImportMemberSetupStatus {
  return IMPORT_MEMBER_SETUP_STATUSES.includes(value as ImportMemberSetupStatus)
    ? (value as ImportMemberSetupStatus)
    : "pending";
}

function toProgress(member: ConfigMember): ImportMemberProgress {
  const setupStatus = toMemberStatus(member.setupStatus);

  return {
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    protectionId: member.protectionId,
    permissionId: member.permissionId,
    setupStatus,
    error: setupStatus === "invite-failed" ? IMPORT_MEMBER_INVITE_FAILED_MESSAGE : null,
  };
}

function buildEmployeeProtectionRequest(
  sheetId: number,
  ownerEmail: string,
  memberEmail: string,
): SheetRequest {
  return {
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: EMPLOYEE_PROTECTION_DESCRIPTION,
        warningOnly: false,
        requestingUserCanEdit: false,
        editors: { users: [ownerEmail, memberEmail], groups: [], domainUsersCanEdit: false },
      },
    },
  };
}

/** Resolves each mapped tab to the numeric sheet ID Google assigned it. */
function resolveTabs(
  snapshot: SpreadsheetSnapshot,
  planned: readonly PlannedMember[],
  storedSheetIds: ReadonlyMap<string, string | null> = new Map(),
): EmployeeTab[] {
  return planned.map((member) => {
    const storedSheetId = storedSheetIds.get(member.email) ?? null;
    const sheet = snapshot.sheets.find((candidate) =>
      storedSheetId === null
        ? candidate.title === member.title
        : String(candidate.sheetId) === storedSheetId,
    );

    if (!sheet) {
      throw new ImportError(
        "member-sheet-missing",
        `The sheet for "${member.email}" is missing from the converted file. It needs repair.`,
      );
    }

    return { ...member, sheetId: sheet.sheetId };
  });
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createImportService(dependencies: ImportServiceDependencies): ImportService {
  const { drive, sheets, config } = dependencies;

  async function protectEmployeeTabs(
    fileId: string,
    tabs: readonly EmployeeTab[],
    ownerEmail: string,
  ): Promise<void> {
    if (tabs.length === 0) return;

    const { replies } = await sheets.batchUpdate(
      fileId,
      tabs.map((tab) => buildEmployeeProtectionRequest(tab.sheetId, ownerEmail, tab.email)),
    );
    const added = replies.flatMap((reply) =>
      reply.addProtectedRange ? [reply.addProtectedRange] : [],
    );

    if (added.length !== tabs.length) {
      throw new ImportError("setup-incomplete", "Google did not return every sheet protection.");
    }

    for (const [index, tab] of tabs.entries()) {
      await config.updateMemberProgress(fileId, {
        email: tab.email,
        protectionId: added[index].protectedRangeId,
      });
    }
  }

  /** Serialized: Drive does not support concurrent permission changes on a file. */
  async function inviteMembers(
    fileId: string,
    members: readonly ImportMemberProgress[],
  ): Promise<ImportMemberProgress[]> {
    const results: ImportMemberProgress[] = [];

    for (const member of members) {
      if (member.setupStatus === "ready" && member.permissionId !== null) {
        results.push(member);
        continue;
      }

      try {
        const permissionId = await drive.createWriterPermission(fileId, member.email);
        await config.updateMemberProgress(fileId, {
          email: member.email,
          permissionId,
          setupStatus: "ready",
        });
        results.push({ ...member, permissionId, setupStatus: "ready", error: null });
      } catch {
        // The file and every completed member stay intact so this one member
        // can be retried on its own.
        await config.updateMemberProgress(fileId, {
          email: member.email,
          setupStatus: "invite-failed",
        });
        results.push({
          ...member,
          setupStatus: "invite-failed",
          error: IMPORT_MEMBER_INVITE_FAILED_MESSAGE,
        });
      }
    }

    return results;
  }

  /** Shared tail of the fresh and resumed paths: invite, then mark the result. */
  async function finishSetup(
    fileId: string,
    fileName: string,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
  ): Promise<ImportResult> {
    const { config: stored } = await config.read(fileId);
    const byEmail = new Map(stored.members.map((member) => [member.email, member]));

    const current = planned.map((member) => {
      const found = byEmail.get(member.email);
      if (!found) {
        throw new ImportError(
          "setup-incomplete",
          "The configuration sheet is missing a member added during import.",
        );
      }
      return toProgress(found);
    });

    const members = await inviteMembers(fileId, current);
    const complete = members.every((member) => member.setupStatus === "ready");
    const setupState: SetupState = complete ? "ready" : "needs-repair";

    await config.updateSetupState(fileId, setupState);

    return {
      fileId,
      fileName,
      month: stored.month,
      folder,
      setupState,
      complete,
      retryable: !complete,
      members,
    };
  }

  async function convertAndConfigure(
    ownerEmail: string,
    request: ImportFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    workbook: Uint8Array,
  ): Promise<ImportResult> {
    // The upload is handed to Drive exactly as it arrived.
    const file = await drive.convertXlsx({
      name: request.fileName,
      folderId: folder.id,
      content: workbook,
    });

    // Recorded before any sheet work so a failure below still leaves a file the
    // dashboard can find and resume.
    await drive.updateAppProperties(file.id, buildAppProperties(request.month, "pending"));

    const snapshot = await sheets.getSpreadsheet(file.id);
    const tabs = resolveTabs(snapshot, planned);

    // `replaceExisting` deletes the workbook's own `__APP_CONFIG`: an uploaded
    // configuration sheet is never trusted, only overwritten.
    await config.initialize({
      fileId: file.id,
      month: request.month,
      ownerEmail,
      templateVersion: TEMPLATE_VERSION,
      statuses: DEFAULT_STATUSES,
      members: tabs.map((tab) => ({
        displayName: tab.displayName,
        email: tab.email,
        sheetId: String(tab.sheetId),
        sheetTitle: tab.title,
        protectionId: null,
        permissionId: null,
        setupStatus: "pending",
      })),
      replaceExisting: true,
    });

    await protectEmployeeTabs(file.id, tabs, ownerEmail);

    return await finishSetup(file.id, file.name, folder, planned);
  }

  async function readResumableConfig(fileId: string): Promise<ConfigReadResult> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        throw new ImportError(
          "resume-unavailable",
          "This file has no attendance configuration to resume. Import the workbook again.",
        );
      }
      throw error;
    }
  }

  async function resumeConvertedFile(
    ownerEmail: string,
    request: ImportFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    fileId: string,
  ): Promise<ImportResult> {
    const existing = await readResumableConfig(fileId);
    const byEmail = new Map(existing.config.members.map((member) => [member.email, member]));
    const tabs = resolveTabs(
      existing.spreadsheet,
      planned,
      new Map([...byEmail].map(([email, member]) => [email, member.sheetId])),
    );

    // A mapping the previous attempt never recorded is re-recorded; the tab
    // itself is left exactly as the workbook produced it.
    for (const tab of tabs) {
      if (byEmail.has(tab.email)) continue;

      await config.updateMemberProgress(fileId, {
        email: tab.email,
        displayName: tab.displayName,
        sheetId: String(tab.sheetId),
        sheetTitle: tab.title,
        setupStatus: "pending",
      });
    }

    const unprotected = tabs.filter((tab) => (byEmail.get(tab.email)?.protectionId ?? null) === null);
    await protectEmployeeTabs(fileId, unprotected, ownerEmail);

    return await finishSetup(fileId, request.fileName, folder, planned);
  }

  return {
    async importWorkbook(input: ImportWorkbookInput): Promise<ImportResult> {
      const ownerEmail = normalizeEmail(input.ownerEmail);
      const planned = await planMembers(input.workbook, input.request);

      // Revalidated under the manager's own identity immediately before any
      // mutation, so a folder that became unavailable rejects the request.
      const folder = await drive.validateManagerFolder(input.request.destinationFolder.id);

      return input.resumeFileId === undefined
        ? await convertAndConfigure(ownerEmail, input.request, folder, planned, input.workbook)
        : await resumeConvertedFile(
            ownerEmail,
            input.request,
            folder,
            planned,
            input.resumeFileId,
          );
    },
  };
}
