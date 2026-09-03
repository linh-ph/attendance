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

import { APP_PROPERTY_MONTH, APP_PROPERTY_SETUP_STATE, toRows } from "@/lib/config/repository";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SHEET_TITLE,
  normalizeEmail,
  readMembers,
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

/**
 * An attendance file Drive listed but whose contents could not be read this
 * request.
 *
 * It exists because the alternative was worse: the employee scan used to drop
 * such a file silently, so a total Sheets outage — a disabled API, a throttle,
 * an expired grant — was indistinguishable from "nobody has shared a timesheet
 * with you". One is a system fault with a recovery step and the other is a
 * normal empty state, and a person cannot act on the first if it is dressed as
 * the second.
 *
 * The entry carries only what Drive already told this actor: the ID and name of
 * a file they can see. The underlying provider error stays server-side.
 */
export interface UnreadableFile {
  id: string;
  name: string;
}

export interface DashboardData {
  folder: DriveFolder | null;
  folderError: FolderError | null;
  managed: ManagedFile[];
  timesheets: Timesheet[];
  /** Empty when every candidate read cleanly. Never a substitute for an error. */
  unreadable: UnreadableFile[];
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
  /** Reads each file's tab list, which is what the person picks from. */
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
/* Drive metadata                                                              */
/* -------------------------------------------------------------------------- */

const SETUP_STATES: ReadonlySet<string> = new Set(["ready", "needs-setup", "needs-repair"]);

/**
 * The setup state a managed card shows, from Drive `appProperties`.
 *
 * The create, import, and setup flows stamp `attendanceSetupState` on the file
 * as well as writing the configuration sheet, so this is the same fact from a
 * source that costs no extra call — discovery used to open every managed file's
 * configuration sheet just to read it back.
 *
 * No stamp means this app has never set the file up, which is exactly
 * `needs-setup`. That is a fact about the Drive metadata, not a guess about the
 * file's contents. `unknown` is left for a stamp this build does not recognise.
 */
function driveSetupState(file: AttendanceFileSummary): DashboardSetupState {
  const stamped = file.appProperties[APP_PROPERTY_SETUP_STATE];
  if (stamped === undefined || stamped === "") return "needs-setup";

  return SETUP_STATES.has(stamped) ? (stamped as DashboardSetupState) : "unknown";
}

/**
 * One managed card, from Drive metadata alone.
 *
 * `memberCount` is `null`: the roster lived in the configuration sheet, and
 * counting it again would mean opening every managed file. The card already
 * treats `null` as "do not show this fact".
 */
function toManagedFile(file: AttendanceFileSummary): ManagedFile {
  return {
    id: file.id,
    name: file.name,
    ownerEmail: file.ownerEmail,
    modifiedTime: file.modifiedTime,
    month: driveMonth(file) ?? monthFromName(file.name),
    memberCount: null,
    setupState: driveSetupState(file),
    error: null,
  };
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

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createFileDiscovery(dependencies: FileDiscoveryDependencies): FileDiscovery {
  const { drive, sheets } = dependencies;

  async function loadManaged(
    folderId: string,
  ): Promise<{ folder: DriveFolder; managed: ManagedFile[] }> {
    // A folder ID from browser storage is never trusted without this check.
    const folder = await drive.validateManagerFolder(folderId);
    const candidates = (await drive.listManagerFiles(folder.id)).filter(
      (file) => file.ownedByMe && hasAttendanceName(file.name),
    );

    // Drive metadata only: no configuration sheet is opened for any card.
    return { folder, managed: candidates.map(toManagedFile) };
  }

  /**
   * Every attendance file this account can open.
   *
   * Neither `sharedWithMe` nor the owner's domain is required any more: a
   * shared-drive file is owned by the organization and satisfies neither, yet
   * is exactly the file people record hours in. Drive returning the file is
   * the access decision.
   */
  /**
   * The tab this file's `__APP_CONFIG!H1:N` maps the signed-in person to, or
   * `null` for every other outcome.
   *
   * Three properties matter more than the happy path:
   *
   * 1. **Email, never a name.** The member row's email is the identity, and it
   *    is compared against the verified server session. A tab *title* is never
   *    evidence of whose tab it is — the day two colleagues share a name, that
   *    guess opens the wrong person's hours.
   * 2. **It costs nothing when there is nothing to read.** The tab list already
   *    says whether `__APP_CONFIG` exists, so a file without one issues no
   *    extra call. That was the measured objection in
   *    `docs/decisions/2026-09-01-nothing-reads-app-config.md`, and it is why
   *    only `H1:N` is read here rather than the whole configuration.
   * 3. **Every failure is `null`, never a throw.** A missing table, a Sheets
   *    error, a manager's typo that makes the table malformed — all of them
   *    mean "pick your tab", which is the behaviour that already worked. A
   *    convenience must not be able to take the calendar down.
   *
   * The mapping is also re-checked against the file's own tab list, so a row
   * pointing at a deleted tab, or at the hidden configuration sheet, resolves
   * to nothing. `tabs` already excludes hidden sheets, which is what keeps a
   * save from writing attendance columns over the settings table.
   */
  async function mappedTab(
    fileId: string,
    sheetSummaries: readonly SheetSummary[],
    tabs: TimesheetTab[],
    actorEmail: string,
  ): Promise<TimesheetTab | null> {
    if (!sheetSummaries.some((sheet) => sheet.title === CONFIG_SHEET_TITLE)) {
      return null;
    }

    try {
      const ranges = await sheets.getValues(fileId, [CONFIG_MEMBER_RANGE]);
      const members = readMembers(toRows(ranges.at(0)?.values));
      const mine = members.find((member) => member.email === actorEmail);

      if (!mine?.sheetId) return null;

      // The stored title is a stale label; the file's live tab list is the truth.
      return tabs.find((tab) => tab.sheetId === mine.sheetId) ?? null;
    } catch {
      return null;
    }
  }

  async function loadTimesheets(actorEmail: string): Promise<{
    timesheets: Timesheet[];
    unreadable: UnreadableFile[];
  }> {
    const candidates = (await drive.listEmployeeCandidates()).filter((file) =>
      hasAttendanceName(file.name),
    );

    const timesheets: Timesheet[] = [];
    const unreadable: UnreadableFile[] = [];

    for (const file of candidates) {
      /*
       * The tab list, plus the mapping this file records for this person.
       *
       * A file whose tabs cannot be read is not offered — but it is *named*, so
       * the caller can tell a provider failure from an account with no
       * timesheets. Swallowing it here is what made a Sheets outage look like
       * an empty Drive.
       *
       * The mapping is the opposite: it is a convenience, so it never decides
       * whether a file is listed. `mappedTab` returns null for every failure
       * and the person picks a tab, exactly as before.
       */
      try {
        const spreadsheet = await sheets.getSpreadsheet(file.id);
        const tabs = toTabs(spreadsheet.sheets);
        const mine = await mappedTab(file.id, spreadsheet.sheets, tabs, actorEmail);

        timesheets.push({
          ...baseTimesheet(file, driveMonth(file) ?? monthFromName(file.name)),
          sheetId: mine?.sheetId ?? null,
          sheetTitle: mine?.title ?? null,
          tabs,
        });
      } catch {
        unreadable.push({ id: file.id, name: file.name });
      }
    }

    return { timesheets, unreadable };
  }

  return {
    async load(request) {
      const actorEmail = normalizeEmail(request.actorEmail);
      const folderId = request.folderId?.trim() ?? "";

      // The employee section is always computed, whatever the folder state is.
      const { timesheets, unreadable } = await loadTimesheets(actorEmail);

      if (folderId === "") {
        return { folder: null, folderError: null, managed: [], timesheets, unreadable };
      }

      try {
        const { folder, managed } = await loadManaged(folderId);
        return { folder, folderError: null, managed, timesheets, unreadable };
      } catch (error) {
        if (error instanceof FolderUnavailableError) {
          return {
            folder: null,
            folderError: { reason: error.reason, message: FOLDER_UNAVAILABLE_MESSAGE },
            managed: [],
            timesheets,
            unreadable,
          };
        }

        throw error;
      }
    },
  };
}
