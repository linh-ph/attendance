/**
 * Folder-scoped manager discovery and shared-file employee discovery.
 *
 * Implements section 5 of the approved design:
 *
 * - The employee section is always computed and never depends on a folder.
 * - The manager section is computed only after `validateManagerFolder` succeeds,
 *   and only from the direct children of that folder. There is no all-Drive
 *   manager fallback and no descendant traversal.
 * - The final `name.includes("勤怠管理表")` test is case-sensitive and applied
 *   here, because Drive's `name contains` operator is prefix-based.
 * - Candidate configurations are read sequentially in v1 so one unreadable file
 *   becomes a card-level error instead of failing the whole dashboard.
 *
 * The actor email is a normalized server-session value. Nothing in this module
 * imports `googleapis`; it depends only on the injected gateway/repository
 * interfaces.
 */

import {
  APP_PROPERTY_MONTH,
  ConfigMissingError,
  isConfigRepositoryError,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import {
  CONFIG_SHEET_TITLE,
  isAppConfigError,
  normalizeEmail,
  type AppConfig,
} from "@/lib/config/schema";
import { FolderUnavailableError } from "@/lib/google/errors";
import {
  ATTENDANCE_NAME_MARKER,
  type AttendanceFileSummary,
  type DriveFolder,
  type DriveGateway,
  type SheetsGateway,
  type SheetSummary,
} from "@/lib/google/types";

/** The workspace domain an employee's file owner must belong to (section 5.2). */
export const ATTENDANCE_OWNER_DOMAIN = "@blended-asia.com";

const UNREADABLE_CONFIG_MESSAGE = "Could not read this file's attendance configuration.";
const BROKEN_CONFIG_MESSAGE = "This file's attendance configuration needs repair.";
const FOLDER_UNAVAILABLE_MESSAGE = "Folder unavailable.";

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `unknown` means the configuration could not be read at all this request. It
 * is deliberately distinct from `needs-repair`, which asserts the stored
 * configuration is structurally broken.
 */
export type DashboardSetupState = "ready" | "needs-setup" | "needs-repair" | "unknown";

export interface ManagedFile {
  id: string;
  name: string;
  ownerEmail: string | null;
  /** `YYYY-MM` from the configuration, falling back to the Drive property. */
  month: string | null;
  modifiedTime: string | null;
  /** `null` when no configuration could be read. */
  memberCount: number | null;
  setupState: DashboardSetupState;
  /** English, card-scoped failure text; `null` when the card loaded cleanly. */
  error: string | null;
}

export interface TimesheetTab {
  /** Numeric Google sheet ID, returned as a string. */
  sheetId: string;
  title: string;
}

export interface Timesheet {
  id: string;
  name: string;
  ownerEmail: string | null;
  month: string | null;
  modifiedTime: string | null;
  /**
   * The tab a configuration maps to this person, or `null` when the file has
   * no configuration. A null mapping is not a refusal: the person picks their
   * own tab from `tabs`, and Google decides what that write may do.
   */
  sheetId: string | null;
  sheetTitle: string | null;
  /** Every visible tab, so an unmapped file can still be opened. */
  tabs: TimesheetTab[];
}

/** `reason` is a server diagnostic and is never rendered to a user. */
export interface FolderError {
  reason: string;
  message: string;
}

export interface DashboardData {
  folder: DriveFolder | null;
  folderError: FolderError | null;
  managed: ManagedFile[];
  timesheets: Timesheet[];
}

export interface LoadDashboardRequest {
  /** Normalized server-session email. Never a client-supplied value. */
  actorEmail: string;
  /** The browser's remembered folder; always revalidated before use. */
  folderId?: string | null;
}

export interface FileDiscovery {
  load(request: LoadDashboardRequest): Promise<DashboardData>;
}

export interface FileDiscoveryDependencies {
  drive: DriveGateway;
  config: ConfigRepository;
  /** Reads the tab list of a file that carries no configuration. */
  sheets: SheetsGateway;
}

/* -------------------------------------------------------------------------- */
/* Candidate rules                                                             */
/* -------------------------------------------------------------------------- */

function hasAttendanceName(name: string): boolean {
  return name.includes(ATTENDANCE_NAME_MARKER);
}

/** `202607勤怠管理表` carries its own month; the name is the only source left. */
function monthFromName(name: string): string | null {
  const match = /(\d{4})-?(\d{2})/.exec(name);
  if (!match) return null;

  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : null;
}

function isInDomain(ownerEmail: string | null): boolean {
  return ownerEmail !== null && normalizeEmail(ownerEmail).endsWith(ATTENDANCE_OWNER_DOMAIN);
}

function driveMonth(file: AttendanceFileSummary): string | null {
  const month = file.appProperties[APP_PROPERTY_MONTH];
  return month === undefined || month === "" ? null : month;
}

function findSheet(sheets: SheetSummary[], sheetId: string): SheetSummary | undefined {
  return sheets.find((sheet) => String(sheet.sheetId) === sheetId);
}

/* -------------------------------------------------------------------------- */
/* Sequential configuration reads                                              */
/* -------------------------------------------------------------------------- */

type ConfigOutcome =
  | { kind: "config"; result: ConfigReadResult }
  | { kind: "missing" }
  | { kind: "broken" }
  | { kind: "unreadable" };

/**
 * Classifies one candidate's configuration. Every failure is contained here so
 * a single bad file degrades to a card state instead of rejecting `load`.
 */
async function readConfigOutcome(
  config: ConfigRepository,
  fileId: string,
): Promise<ConfigOutcome> {
  try {
    return { kind: "config", result: await config.read(fileId) };
  } catch (error) {
    if (error instanceof ConfigMissingError) return { kind: "missing" };
    if (isConfigRepositoryError(error) || isAppConfigError(error)) return { kind: "broken" };
    return { kind: "unreadable" };
  }
}

function managedSetupState(config: AppConfig): DashboardSetupState {
  if (config.setupState === "ready") return "ready";
  if (config.setupState === "needs-repair") return "needs-repair";
  return "needs-setup";
}

function toManagedFile(file: AttendanceFileSummary, outcome: ConfigOutcome): ManagedFile {
  const base = {
    id: file.id,
    name: file.name,
    ownerEmail: file.ownerEmail,
    modifiedTime: file.modifiedTime,
  };

  if (outcome.kind === "config") {
    const { config } = outcome.result;
    return {
      ...base,
      month: config.month,
      memberCount: config.members.length,
      setupState: managedSetupState(config),
      error: null,
    };
  }

  const setupState: DashboardSetupState =
    outcome.kind === "missing" ? "needs-setup" : outcome.kind === "broken" ? "needs-repair" : "unknown";

  const error =
    outcome.kind === "missing"
      ? null
      : outcome.kind === "broken"
        ? BROKEN_CONFIG_MESSAGE
        : UNREADABLE_CONFIG_MESSAGE;

  return { ...base, month: driveMonth(file), memberCount: null, setupState, error };
}

/**
 * Resolves the actor's single mapped sheet, or `null` when the file must not
 * appear in the employee section (zero or several mappings, an unmapped member
 * row, or a mapped sheet that no longer exists).
 */
/** Visible, recordable tabs. The hidden configuration sheet is never one. */
function toTabs(sheets: readonly SheetSummary[]): TimesheetTab[] {
  return sheets
    .filter((sheet) => sheet.title !== CONFIG_SHEET_TITLE && !sheet.hidden)
    .map((sheet) => ({ sheetId: String(sheet.sheetId), title: sheet.title }));
}

function baseTimesheet(file: AttendanceFileSummary, month: string | null) {
  return {
    id: file.id,
    name: file.name,
    ownerEmail: file.ownerEmail === null ? null : normalizeEmail(file.ownerEmail),
    month,
    modifiedTime: file.modifiedTime,
  };
}

/**
 * A configured file still resolves the actor to their mapped tab, which keeps
 * the familiar one-click path. A file with no configuration is not refused: it
 * is returned with its tab list so the person opens whichever tab is theirs.
 */
function toTimesheet(
  file: AttendanceFileSummary,
  outcome: ConfigOutcome,
  actorEmail: string,
): Timesheet | null {
  if (outcome.kind !== "config") return null;

  const { config, spreadsheet } = outcome.result;
  const tabs = toTabs(spreadsheet.sheets);
  const matches = config.members.filter((member) => normalizeEmail(member.email) === actorEmail);

  if (matches.length === 1 && matches[0].sheetId !== null) {
    // The sheet ID is the identity key; never fall back to matching by title.
    const sheet = findSheet(spreadsheet.sheets, matches[0].sheetId);
    if (sheet) {
      return {
        ...baseTimesheet(file, config.month),
        sheetId: String(sheet.sheetId),
        sheetTitle: sheet.title,
        tabs,
      };
    }
  }

  return { ...baseTimesheet(file, config.month), sheetId: null, sheetTitle: null, tabs };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createFileDiscovery(dependencies: FileDiscoveryDependencies): FileDiscovery {
  const { drive, config, sheets } = dependencies;

  async function loadManaged(
    folderId: string,
  ): Promise<{ folder: DriveFolder; managed: ManagedFile[] }> {
    // A folder ID from browser storage is never trusted without this check.
    const folder = await drive.validateManagerFolder(folderId);
    const candidates = (await drive.listManagerFiles(folder.id)).filter(
      (file) => file.ownedByMe && hasAttendanceName(file.name),
    );

    const managed: ManagedFile[] = [];
    for (const file of candidates) {
      managed.push(toManagedFile(file, await readConfigOutcome(config, file.id)));
    }

    return { folder, managed };
  }

  /**
   * Every attendance file this account can open.
   *
   * Neither `sharedWithMe` nor the owner's domain is required any more: a
   * shared-drive file is owned by the organization and satisfies neither, yet
   * is exactly the file people record hours in. Drive returning the file is
   * the access decision.
   */
  async function loadTimesheets(actorEmail: string): Promise<Timesheet[]> {
    const candidates = (await drive.listEmployeeCandidates()).filter((file) =>
      hasAttendanceName(file.name),
    );

    const timesheets: Timesheet[] = [];
    for (const file of candidates) {
      const outcome = await readConfigOutcome(config, file.id);

      if (outcome.kind === "config") {
        const timesheet = toTimesheet(file, outcome, actorEmail);
        if (timesheet) timesheets.push(timesheet);
        continue;
      }

      // No configuration: read the tab list directly so the file is still
      // openable. A file whose tabs cannot be read at all is skipped.
      try {
        const spreadsheet = await sheets.getSpreadsheet(file.id);
        timesheets.push({
          ...baseTimesheet(file, monthFromName(file.name)),
          sheetId: null,
          sheetTitle: null,
          tabs: toTabs(spreadsheet.sheets),
        });
      } catch {
        continue;
      }
    }

    return timesheets;
  }

  return {
    async load(request) {
      const actorEmail = normalizeEmail(request.actorEmail);
      const folderId = request.folderId?.trim() ?? "";

      // The employee section is always computed, whatever the folder state is.
      const timesheets = await loadTimesheets(actorEmail);

      if (folderId === "") {
        return { folder: null, folderError: null, managed: [], timesheets };
      }

      try {
        const { folder, managed } = await loadManaged(folderId);
        return { folder, folderError: null, managed, timesheets };
      } catch (error) {
        if (error instanceof FolderUnavailableError) {
          return {
            folder: null,
            folderError: { reason: error.reason, message: FOLDER_UNAVAILABLE_MESSAGE },
            managed: [],
            timesheets,
          };
        }

        throw error;
      }
    },
  };
}
