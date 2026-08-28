/**
 * Retryable monthly attendance file setup.
 *
 * The service composes the Drive/Sheets gateways and the sheet-native config
 * repository into the create flow of section 8.1 of the approved design:
 *
 * 1. revalidate the destination folder immediately before Drive creation;
 * 2. create the spreadsheet under the manager's own OAuth identity;
 * 3. record `pending` so a half-configured file is still discoverable;
 * 4. create the employee tabs and the protected `__APP_CONFIG` tab;
 * 5. add protections;
 * 6. invite one unique employee email at a time — Drive does not support
 *    concurrent permission changes on one file;
 * 7. keep individual invitation failures next to their member;
 * 8. mark `ready` only when every step succeeded.
 *
 * A created file is never deleted as rollback (section 9.2). A failed attempt
 * returns the file ID, the revalidated folder, and per-member progress so the
 * browser can resume with `resumeFileId`.
 *
 * Progress invariant: a member row carries a `sheetId` only once that tab has
 * been created *and* templated. `buildEmployeeSheetPlan` shrinks the grid to the
 * month's row count, which is safe on a fresh tab and destructive on a populated
 * one, so a resume never replays the template onto an existing tab.
 */

import { STATUS_OPTIONS } from "@/lib/attendance/model";
import { ForbiddenError, authorizeFile } from "@/lib/access/policy";
import {
  APP_PROPERTY_MONTH,
  ConfigMissingError,
  buildAppProperties,
  isConfigRepositoryError,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import {
  CONFIG_SHEET_TITLE,
  isAppConfigError,
  normalizeEmail,
  type ConfigMember,
  type ConfigStatus,
  type SetupState,
} from "@/lib/config/schema";
import {
  ATTENDANCE_NAME_MARKER,
  type DriveFolder,
  type DriveGateway,
  type SheetRequest,
  type SheetsGateway,
  type SpreadsheetSnapshot,
} from "@/lib/google/types";
import {
  TEMPLATE_VERSION,
  buildEmployeeSheetPlan,
  buildEmployeeSheetTitles,
} from "@/lib/workbook/template";
import type { CreateFileInput, CreateFileMemberInput } from "./schemas";

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

const EMPLOYEE_PROTECTION_DESCRIPTION = "Attendance employee sheet";

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
  title: string;
}

interface EmployeeTab extends PlannedMember {
  sheetId: number;
}

/**
 * Rejects duplicate identities before any Google call so a rejected request
 * never leaves a half-created file behind.
 */
function planMembers(members: readonly CreateFileMemberInput[]): PlannedMember[] {
  const seen = new Set<string>();

  const normalized = members.map((member) => {
    const email = normalizeEmail(member.email);
    if (seen.has(email)) {
      throw new SetupError(
        "duplicate-member-email",
        `Member email "${email}" is listed more than once.`,
      );
    }

    seen.add(email);
    return { displayName: member.displayName.trim(), email };
  });

  // Throws SheetTitleError for empty, reserved, illegal, or duplicate tab names.
  const titles = buildEmployeeSheetTitles(normalized.map((member) => member.displayName));

  return normalized.map((member, index) => ({ ...member, title: titles[index] }));
}

/** A mapping after normalization, before it is matched to a live tab. */
interface MappedMember {
  displayName: string;
  email: string;
  sheetId: string;
}

/**
 * Rejects an ambiguous mapping table before any Google call, so a rejected
 * request never configures, shares, or protects anything.
 */
function planExistingMappings(mappings: readonly ExistingSheetMapping[]): MappedMember[] {
  const seenEmails = new Set<string>();
  const seenSheetIds = new Set<string>();

  return mappings.map((mapping) => {
    const email = normalizeEmail(mapping.email);
    const sheetId = mapping.sheetId.trim();

    if (seenEmails.has(email)) {
      throw new LegacySetupError(
        "duplicate-member-email",
        `Member email "${email}" is listed more than once.`,
      );
    }
    if (seenSheetIds.has(sheetId)) {
      throw new LegacySetupError(
        "duplicate-sheet-mapping",
        "Assign each sheet in this file to exactly one member.",
      );
    }

    seenEmails.add(email);
    seenSheetIds.add(sheetId);

    return { displayName: mapping.displayName.trim(), email, sheetId };
  });
}

function employeeSheets(snapshot: SpreadsheetSnapshot): SpreadsheetSnapshot["sheets"] {
  return snapshot.sheets.filter((sheet) => sheet.title !== CONFIG_SHEET_TITLE);
}

/**
 * Resolves every mapping onto a tab that exists right now, and requires the
 * mapping table to cover every managed employee sheet. The stored title is
 * always the live one: a tab is identified by its numeric ID, never by a name
 * the browser sent.
 */
function resolveExistingTabs(
  snapshot: SpreadsheetSnapshot,
  mapped: readonly MappedMember[],
): EmployeeTab[] {
  const sheets = employeeSheets(snapshot);

  const tabs = mapped.map((member) => {
    const sheet = sheets.find((candidate) => String(candidate.sheetId) === member.sheetId);
    if (!sheet) {
      throw new LegacySetupError(
        "member-sheet-missing",
        `The sheet mapped to "${member.email}" is missing from this file.`,
      );
    }

    return {
      displayName: member.displayName === "" ? sheet.title : member.displayName,
      email: member.email,
      title: sheet.title,
      sheetId: sheet.sheetId,
    };
  });

  const mappedSheetIds = new Set(tabs.map((tab) => tab.sheetId));
  const unmapped = sheets.find((sheet) => !mappedSheetIds.has(sheet.sheetId));

  if (unmapped) {
    throw new LegacySetupError(
      "unmapped-employee-sheet",
      `Sheet "${unmapped.title}" has no employee assigned to it.`,
    );
  }

  return tabs;
}

function toMemberStatus(value: string): MemberSetupStatus {
  return MEMBER_SETUP_STATUSES.includes(value as MemberSetupStatus)
    ? (value as MemberSetupStatus)
    : "pending";
}

function toProgress(member: ConfigMember): MemberSetupProgress {
  const setupStatus = toMemberStatus(member.setupStatus);

  return {
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    protectionId: member.protectionId,
    permissionId: member.permissionId,
    setupStatus,
    error: setupStatus === "invite-failed" ? MEMBER_INVITE_FAILED_MESSAGE : null,
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

function hasSheet(snapshot: SpreadsheetSnapshot, sheetId: string): boolean {
  return snapshot.sheets.some((sheet) => String(sheet.sheetId) === sheetId);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createSetupService(dependencies: SetupServiceDependencies): SetupService {
  const { drive, sheets, config } = dependencies;

  /**
   * Adds one tab per member and removes the tabs Drive created with the file,
   * in a single batch so the workbook is never left without a sheet.
   */
  async function createEmployeeTabs(
    fileId: string,
    members: readonly PlannedMember[],
    removeSheetIds: readonly number[],
  ): Promise<EmployeeTab[]> {
    const requests: SheetRequest[] = [
      ...members.map((member) => ({ addSheet: { properties: { title: member.title } } })),
      ...removeSheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })),
    ];

    const { replies } = await sheets.batchUpdate(fileId, requests);
    const added = replies.flatMap((reply) => (reply.addSheet ? [reply.addSheet] : []));

    if (added.length !== members.length) {
      throw new SetupError(
        "setup-incomplete",
        "Google did not return every created employee sheet.",
      );
    }

    return members.map((member, index) => ({ ...member, sheetId: added[index].sheetId }));
  }

  /** Only ever applied to tabs created in this request. */
  async function applyEmployeeTemplates(
    fileId: string,
    tabs: readonly EmployeeTab[],
    month: string,
    statuses: readonly ConfigStatus[],
  ): Promise<void> {
    const requests = tabs.flatMap((tab) => [
      ...buildEmployeeSheetPlan({ sheetId: tab.sheetId, month, statuses }).requests,
    ]);

    if (requests.length > 0) {
      await sheets.batchUpdate(fileId, requests);
    }
  }

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
      throw new SetupError("setup-incomplete", "Google did not return every sheet protection.");
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
    members: readonly MemberSetupProgress[],
  ): Promise<MemberSetupProgress[]> {
    const results: MemberSetupProgress[] = [];

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
          error: MEMBER_INVITE_FAILED_MESSAGE,
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
  ): Promise<MonthlySetupResult> {
    const { config: stored } = await config.read(fileId);
    const byEmail = new Map(stored.members.map((member) => [member.email, member]));

    const current = planned.map((member) => {
      const found = byEmail.get(member.email);
      if (!found) {
        throw new SetupError(
          "setup-incomplete",
          "The configuration sheet is missing a member added during setup.",
        );
      }
      return toProgress(found);
    });

    const members = await inviteMembers(fileId, current);
    const complete = members.every((member) => member.setupStatus === "ready");

    if (complete) {
      await config.updateSetupState(fileId, "ready");
    }

    return {
      fileId,
      fileName,
      month: stored.month,
      folder,
      setupState: complete ? "ready" : "pending",
      complete,
      members,
    };
  }

  async function buildNewFile(
    ownerEmail: string,
    request: CreateFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
  ): Promise<MonthlySetupResult> {
    const file = await drive.createSpreadsheetFile({ name: request.fileName, folderId: folder.id });

    // Recorded before any sheet work so a failure below still leaves a file the
    // dashboard can find and resume.
    await drive.updateAppProperties(file.id, buildAppProperties(request.month, "pending"));

    const initial = await sheets.getSpreadsheet(file.id);
    const tabs = await createEmployeeTabs(
      file.id,
      planned,
      initial.sheets.map((sheet) => sheet.sheetId),
    );
    await applyEmployeeTemplates(file.id, tabs, request.month, DEFAULT_STATUSES);

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
    });

    await protectEmployeeTabs(file.id, tabs, ownerEmail);

    return await finishSetup(file.id, file.name, folder, planned);
  }

  async function readResumableConfig(fileId: string): Promise<ConfigReadResult> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        throw new SetupError(
          "resume-unavailable",
          "This file has no attendance configuration to resume. Run setup for it instead.",
        );
      }
      throw error;
    }
  }

  async function resumeFile(
    ownerEmail: string,
    request: CreateFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    fileId: string,
  ): Promise<MonthlySetupResult> {
    const existing = await readResumableConfig(fileId);
    const byEmail = new Map(existing.config.members.map((member) => [member.email, member]));

    // A recorded tab that no longer exists is a repair case, never a silent
    // rebuild: recreating it would discard whatever the member already saved.
    for (const member of existing.config.members) {
      if (member.sheetId !== null && !hasSheet(existing.spreadsheet, member.sheetId)) {
        throw new SetupError(
          "member-sheet-missing",
          "A configured employee sheet is missing from this file. It needs repair.",
        );
      }
    }

    // Only members without a completed tab are created; an existing tab is
    // reconciled by leaving it exactly as it is.
    const missingTabs = planned.filter((member) => {
      const stored = byEmail.get(member.email);
      return stored === undefined || stored.sheetId === null;
    });

    const createdTabs =
      missingTabs.length === 0
        ? []
        : await createEmployeeTabs(fileId, missingTabs, []);

    if (createdTabs.length > 0) {
      await applyEmployeeTemplates(fileId, createdTabs, existing.config.month, existing.config.statuses);

      for (const tab of createdTabs) {
        await config.updateMemberProgress(fileId, {
          email: tab.email,
          displayName: tab.displayName,
          sheetId: String(tab.sheetId),
          sheetTitle: tab.title,
          setupStatus: "pending",
        });
      }
    }

    const unprotected = planned.flatMap((member) => {
      const created = createdTabs.find((tab) => tab.email === member.email);
      if (created) return [created];

      const stored = byEmail.get(member.email);
      if (!stored || stored.sheetId === null || stored.protectionId !== null) return [];

      return [{ ...member, sheetId: Number(stored.sheetId) }];
    });

    await protectEmployeeTabs(fileId, unprotected, ownerEmail);

    return await finishSetup(fileId, request.fileName, folder, planned);
  }

  /**
   * The legacy-file guard (section 7.3 plus section 5.3).
   *
   * Drive metadata discovery alone never authorizes a mutation on a legacy
   * file, so every entry point re-derives the role from current ownership and
   * re-proves the file is still a direct child of the manager's active folder
   * under that manager's own identity. The Drive name wins over anything the
   * browser sent.
   */
  async function requireLegacyManagerFile(
    ownerEmail: string,
    fileId: string,
    folderId: string,
  ): Promise<{ folder: DriveFolder; fileName: string; driveMonth: string | null }> {
    const role = await authorizeFile({ drive, config }, { fileId, actorEmail: ownerEmail });
    if (role.kind !== "manager") {
      throw new ForbiddenError("actor-not-owner");
    }

    const folder = await drive.validateManagerFolder(folderId);
    const file = (await drive.listManagerFiles(folder.id)).find(
      (candidate) => candidate.id === fileId,
    );

    if (!file || !file.ownedByMe) {
      throw new ForbiddenError("file-not-in-folder");
    }

    if (!file.name.includes(ATTENDANCE_NAME_MARKER)) {
      throw new LegacySetupError(
        "file-not-supported",
        "This file is not an attendance file. Rename it before setting it up.",
      );
    }

    const driveMonth = file.appProperties[APP_PROPERTY_MONTH];

    return {
      folder,
      fileName: file.name,
      driveMonth: driveMonth === undefined || driveMonth === "" ? null : driveMonth,
    };
  }

  /**
   * The configuration this app can actually trust, or `null`.
   *
   * A missing, broken, or foreign `__APP_CONFIG` all resolve to `null`: setup
   * replaces such a sheet rather than reading anything out of it.
   */
  async function readTrustedConfig(fileId: string): Promise<ConfigReadResult | null> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (
        error instanceof ConfigMissingError ||
        isConfigRepositoryError(error) ||
        isAppConfigError(error)
      ) {
        return null;
      }
      throw error;
    }
  }

  /** First attempt: write the current schema over whatever config sheet exists. */
  async function initializeExistingFile(
    fileId: string,
    month: string,
    ownerEmail: string,
    tabs: readonly EmployeeTab[],
  ): Promise<void> {
    await config.initialize({
      fileId,
      month,
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
      // An `__APP_CONFIG` this app did not write is never trusted, only replaced.
      replaceExisting: true,
    });

    await protectEmployeeTabs(fileId, tabs, ownerEmail);
  }

  /**
   * Retry: the stored rows own the progress, so a completed protection or
   * invitation is never repeated and no tab is touched.
   */
  async function resumeExistingFile(
    fileId: string,
    ownerEmail: string,
    tabs: readonly EmployeeTab[],
    stored: ConfigReadResult,
  ): Promise<void> {
    const byEmail = new Map(stored.config.members.map((member) => [member.email, member]));

    // Checked before any write: re-pointing a member would orphan the
    // protection recorded for their previous tab.
    for (const tab of tabs) {
      const member = byEmail.get(tab.email);
      if (member && member.sheetId !== null && member.sheetId !== String(tab.sheetId)) {
        throw new LegacySetupError(
          "mapping-conflict",
          `This file already maps "${tab.email}" to a different sheet. It needs repair.`,
        );
      }
    }

    for (const tab of tabs) {
      const member = byEmail.get(tab.email);
      if (member && member.sheetId !== null) continue;

      await config.updateMemberProgress(fileId, {
        email: tab.email,
        displayName: tab.displayName,
        sheetId: String(tab.sheetId),
        sheetTitle: tab.title,
        setupStatus: "pending",
      });
    }

    const unprotected = tabs.filter(
      (tab) => (byEmail.get(tab.email)?.protectionId ?? null) === null,
    );
    await protectEmployeeTabs(fileId, unprotected, ownerEmail);
  }

  return {
    async create(input: CreateMonthlyFileInput): Promise<MonthlySetupResult> {
      const ownerEmail = normalizeEmail(input.ownerEmail);
      const planned = planMembers(input.request.members);

      // Revalidated under the manager's own identity immediately before any
      // mutation, so a folder that became unavailable rejects the request.
      const folder = await drive.validateManagerFolder(input.request.destinationFolder.id);

      return input.resumeFileId === undefined
        ? await buildNewFile(ownerEmail, input.request, folder, planned)
        : await resumeFile(ownerEmail, input.request, folder, planned, input.resumeFileId);
    },

    async inspectExisting(input: InspectExistingFileInput): Promise<ExistingFileInspection> {
      const ownerEmail = normalizeEmail(input.ownerEmail);
      const { folder, fileName, driveMonth } = await requireLegacyManagerFile(
        ownerEmail,
        input.fileId,
        input.folderId,
      );

      const snapshot = await sheets.getSpreadsheet(input.fileId);
      const stored = await readTrustedConfig(input.fileId);
      const hasConfigSheet = snapshot.sheets.some((sheet) => sheet.title === CONFIG_SHEET_TITLE);

      return {
        fileId: input.fileId,
        fileName,
        folder,
        month: stored?.config.month ?? driveMonth,
        sheets: employeeSheets(snapshot).map((sheet) => ({
          sheetId: String(sheet.sheetId),
          title: sheet.title,
        })),
        hasUntrustedConfig: hasConfigSheet && stored === null,
        members: stored === null ? [] : stored.config.members.map(toProgress),
      };
    },

    async configureExisting(input: ConfigureExistingFileInput): Promise<MonthlySetupResult> {
      const ownerEmail = normalizeEmail(input.ownerEmail);

      // Pure validation first: an ambiguous mapping table never reaches Google.
      const mapped = planExistingMappings(input.mappings);

      const { folder, fileName } = await requireLegacyManagerFile(
        ownerEmail,
        input.fileId,
        input.folderId,
      );

      // The tabs are only ever read and protected here. `buildEmployeeSheetPlan`
      // is deliberately absent: its grid resize would truncate the attendance
      // rows this file already holds.
      const snapshot = await sheets.getSpreadsheet(input.fileId);
      const tabs = resolveExistingTabs(snapshot, mapped);

      const stored = await readTrustedConfig(input.fileId);

      if (stored === null) {
        await initializeExistingFile(input.fileId, input.month, ownerEmail, tabs);
      } else {
        await resumeExistingFile(input.fileId, ownerEmail, tabs, stored);
      }

      return await finishSetup(input.fileId, fileName, folder, tabs);
    },
  };
}
