/**
 * Authorized attendance read and exact dirty-range save.
 *
 * Every entry point re-authorizes through `authorizeFile` (design section 7.3)
 * *before* a single attendance value is read, so an employee addressing another
 * employee's sheet is refused without that sheet ever being fetched.
 *
 * Saves accept field keys and a calendar date — never a client-supplied A1
 * range. The row is resolved from column A on the server, the addressable cells
 * are derived from the committed workbook contract, and the write is the
 * smallest `values.batchUpdate` the diff allows. Column H keeps its `=F-G-E`
 * formula and is never written (design section 8.3).
 *
 * The module depends only on the gateway/repository interfaces; nothing here
 * imports `googleapis`.
 */

import {
  authorizeFile,
  ForbiddenError,
  NeedsRepairError,
  NeedsSetupError,
  type FileRole,
} from "@/lib/access/policy";
import {
  ConfigMissingError,
  createConfigRepository,
  isConfigRepositoryError,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import { isAppConfigError, type AppConfig, type ConfigStatus } from "@/lib/config/schema";
import type {
  CellValue,
  DriveGateway,
  SheetsGateway,
  SpreadsheetSnapshot,
  ValueInputOption,
  ValuePatch,
} from "@/lib/google/types";
import {
  DATA_START_ROW,
  REFERENCE_COLUMN_BY_KEY,
  WORK_SLOT_COLUMNS,
  WORK_SLOT_LAST_COLUMN,
} from "@/lib/workbook/contract";
import { emptyDay, STATUS_OPTIONS, type AttendanceDay, type TimeSlot } from "./model";
import { diffDay, type CellPatch } from "./range-mapper";
import { TIME_SLOTS } from "./slots";
import { calculateWorkHours, validateAttendanceDay, type ValidationIssue } from "./validation";
import { normalizeSpreadsheetTimeZone } from "./zone";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AttendanceErrorCode = "invalid-request" | "invalid-day" | "sheet-structure";

const ATTENDANCE_ERROR_MESSAGES: Record<AttendanceErrorCode, string> = {
  "invalid-request": "The attendance save request is not valid.",
  "invalid-day": "Check the clock, break, and work-hour values.",
  "sheet-structure": "This attendance sheet changed. Reload it and try again.",
};

export class AttendanceError extends Error {
  readonly code: AttendanceErrorCode;
  /** Server-side diagnostic. Safe to log; never rendered to another actor. */
  readonly reason: string;
  readonly issues: ValidationIssue[];

  constructor(code: AttendanceErrorCode, reason: string, issues: ValidationIssue[] = []) {
    super(ATTENDANCE_ERROR_MESSAGES[code]);
    this.name = "AttendanceError";
    this.code = code;
    this.reason = reason;
    this.issues = issues;
  }
}

export function isAttendanceError(value: unknown): value is AttendanceError {
  return value instanceof AttendanceError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface AttendanceDependencies {
  drive: DriveGateway;
  sheets: SheetsGateway;
  /** Injected in tests; defaults to the sheet-native repository. */
  config?: ConfigRepository;
}

export type AttendanceRole = "manager" | "employee" | "open";

export interface ReadAttendanceRequest {
  fileId: string;
  /** Normalized server-session email. Never a client-supplied value. */
  actorEmail: string;
  /** Numeric sheet ID from the route, as a string. */
  sheetId: string;
}

export interface AttendanceMonthView {
  fileId: string;
  sheetId: number;
  sheetTitle: string;
  /** `YYYY-MM`, from the protected configuration. */
  month: string;
  /**
   * The spreadsheet's own IANA timezone, from
   * `spreadsheet.properties.timeZone`, validated here — or `null` when it is
   * missing or is not a real IANA identifier.
   *
   * `Today` is derived from this and from nothing else. A `null` means the
   * client leaves the calendar navigable, disables `Today`, and says the
   * spreadsheet timezone could not be determined. It must never be replaced
   * with UTC or with the browser's zone: two people in different countries
   * looking at the same workbook have to agree on which row is today.
   *
   * `readAttendanceMonth` always sets it, and a test asserts the key is
   * present rather than merely absent-and-therefore-`undefined`. It is
   * declared optional only so month-view fixtures written before this field
   * existed still typecheck; treat `undefined` exactly as `null` —
   * `todayInZone` already does.
   */
  spreadsheetTimeZone?: string | null;
  role: AttendanceRole;
  statuses: ConfigStatus[];
  days: AttendanceDay[];
}

/**
 * One client-addressable cell, keyed by field rather than A1.
 *
 * Columns A/B/C (generated) and H (`=F-G-E`) have no field key, so they are
 * unaddressable by construction rather than by a deny list.
 */
export type AttendancePatch =
  | { field: "status"; baseline: string | null; value: string | null }
  | { field: "clockIn"; baseline: number | null; value: number | null }
  | { field: "clockOut"; baseline: number | null; value: number | null }
  | { field: "breakHours"; baseline: number; value: number }
  | { field: "notes"; baseline: string; value: string }
  | { field: "slot"; slot: TimeSlot; baseline: string; value: string };

export interface SaveAttendanceRequest {
  fileId: string;
  actorEmail: string;
  sheetId: string;
  /** `YYYY-MM-DD`, inside the configured month. */
  date: string;
  patches: AttendancePatch[];
}

/** A dirty cell whose live sheet value diverged from the client's baseline. */
export interface AttendanceConflict {
  range: string;
  baseline: CellValue;
  current: CellValue;
}

export interface SaveAttendanceResult {
  /** 1-based sheet row resolved from column A. */
  row: number;
  /** Recalculated `F-G-E` for the saved day; column H itself is never written. */
  workHours: number | null;
  written: CellPatch[];
  conflicts: AttendanceConflict[];
}

/* -------------------------------------------------------------------------- */
/* A1 and calendar helpers                                                     */
/* -------------------------------------------------------------------------- */

const SHEET_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Quotes a sheet title for an A1 range, escaping embedded apostrophes. */
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function monthDates(month: string): string[] {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new NeedsRepairError("config-month-unreadable");

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const total = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  return Array.from({ length: total }, (_, offset) =>
    new Date(Date.UTC(year, monthIndex, offset + 1)).toISOString().slice(0, 10),
  );
}

/** Spreadsheet serial number for a calendar date (1899-12-30 epoch). */
function toSerialDate(isoDate: string): number {
  return (Date.parse(`${isoDate}T00:00:00.000Z`) - SHEET_EPOCH_UTC_MS) / MS_PER_DAY;
}

/**
 * True when a column-A cell holds the expected calendar date.
 *
 * Sheets returns dates as serial numbers under `UNFORMATTED_VALUE`; an imported
 * workbook may still hold a text date, so both forms are accepted.
 */
function isDateCell(cell: CellValue | undefined, isoDate: string): boolean {
  if (typeof cell === "number") return cell === toSerialDate(isoDate);
  if (typeof cell === "string") return cell.trim().slice(0, 10) === isoDate;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Cell conversion                                                             */
/* -------------------------------------------------------------------------- */

const COLUMN = REFERENCE_COLUMN_BY_KEY;

function cellText(cell: CellValue | undefined): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "string" ? cell : String(cell);
}

function cellNumber(cell: CellValue | undefined): number | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return cell;
  if (typeof cell === "string" && cell.trim() !== "") {
    const parsed = Number(cell);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Reads a 0-based row array at the contract's 1-based column index. */
function columnValue(row: CellValue[], index: number): CellValue | undefined {
  return row[index - 1];
}

/**
 * Converts one raw sheet row into the day model.
 *
 * A status value outside the configured enum maps to `null` rather than being
 * surfaced as arbitrary text: the web never writes free-form status, and the
 * untouched cell is only overwritten when the user explicitly changes it.
 */
function toAttendanceDay(
  date: string,
  row: CellValue[],
  statuses: readonly ConfigStatus[],
): AttendanceDay {
  const base = emptyDay(date);
  const slots = { ...base.slots };

  for (const column of WORK_SLOT_COLUMNS) {
    slots[column.slot] = cellText(columnValue(row, column.index));
  }

  const sheetStatus = cellText(columnValue(row, COLUMN.status.index));
  const status = statuses.find((candidate) => candidate.sheetValue === sheetStatus);
  const breakHours = cellNumber(columnValue(row, COLUMN.breakHours.index)) ?? 0;

  return {
    ...base,
    statusCode: status ? status.code : null,
    clockIn: cellNumber(columnValue(row, COLUMN.clockIn.index)),
    clockOut: cellNumber(columnValue(row, COLUMN.clockOut.index)),
    breakHours,
    workHours: cellNumber(columnValue(row, COLUMN.workHours.index)),
    // Inferred only when the break is the reserved hour and both lunch slots
    // are free; the editor may still toggle it explicitly in the draft.
    lunchBreak: breakHours === 1 && slots["12:00"] === "" && slots["12:30"] === "",
    notes: cellText(columnValue(row, COLUMN.notes.index)),
    slots,
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration and authorization                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reads the protected configuration at most once per service call.
 *
 * `authorizeFile` reads it for every non-owner request; caching keeps the
 * manager and employee paths on one read without weakening either check.
 */
function cachedConfigRepository(repository: ConfigRepository): ConfigRepository {
  const pending = new Map<string, Promise<ConfigReadResult>>();

  return {
    read(fileId) {
      const cached = pending.get(fileId) ?? repository.read(fileId);
      pending.set(fileId, cached);
      return cached;
    },
    initialize: (input) => repository.initialize(input),
    updateMemberProgress: (fileId, update) => repository.updateMemberProgress(fileId, update),
    updateSetupState: (fileId, setupState) => repository.updateSetupState(fileId, setupState),
  };
}

/** Mirrors the policy mapping: a broken mapping is never a silent fallback. */
async function readConfig(
  repository: ConfigRepository,
  fileId: string,
): Promise<ConfigReadResult> {
  try {
    return await repository.read(fileId);
  } catch (error) {
    if (error instanceof ConfigMissingError) throw new NeedsSetupError("config-sheet-missing");
    if (isConfigRepositoryError(error)) throw new NeedsRepairError(`config-repository:${error.code}`);
    if (isAppConfigError(error)) throw new NeedsRepairError(`config-unreadable:${error.code}`);
    throw error;
  }
}

interface AttendanceTarget {
  role: AttendanceRole;
  sheetId: number;
  sheetTitle: string;
  config: AppConfig;
  month: string;
  dates: string[];
  /** Validated IANA zone, or `null`. Taken from the snapshot already fetched. */
  spreadsheetTimeZone: string | null;
}

/**
 * A manager may address any mapped member sheet in the file they own; the
 * configuration sheet and any unmapped tab stay forbidden for everyone.
 */
function resolveManagerSheet(
  config: AppConfig,
  spreadsheet: SpreadsheetSnapshot,
  requestedSheetId: string,
): { sheetId: number; sheetTitle: string } {
  const member = config.members.find((candidate) => candidate.sheetId === requestedSheetId);
  if (!member) throw new ForbiddenError("requested-sheet-not-mapped");

  const sheet = spreadsheet.sheets.find((candidate) => String(candidate.sheetId) === requestedSheetId);
  if (!sheet) throw new NeedsRepairError("member-sheet-missing");

  // The live title wins so a renamed tab stays addressable by ID.
  return { sheetId: sheet.sheetId, sheetTitle: sheet.title };
}

/** The status enum a file without a configuration falls back to. */
const FALLBACK_STATUSES: ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

/**
 * The month a file with no configuration covers, taken from its Drive name:
 * `202607勤怠管理表` is July 2026. It is the only source left once there is no
 * configuration sheet to read it from.
 */
function monthFromName(name: string): string | null {
  const match = /(\d{4})-?(\d{2})/.exec(name);
  if (!match) return null;

  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : null;
}

/**
 * The target for a file this app never configured.
 *
 * There is no roster to resolve against, so the requested tab is taken as
 * given and the status list falls back to the workbook defaults. Google has
 * already decided the person may open the file.
 */
async function resolveOpenTarget(
  dependencies: AttendanceDependencies,
  request: { fileId: string; sheetId: string },
): Promise<AttendanceTarget> {
  const [access, spreadsheet] = await Promise.all([
    dependencies.drive.getFileAccess(request.fileId),
    dependencies.sheets.getSpreadsheet(request.fileId),
  ]);

  const sheet = spreadsheet.sheets.find(
    (candidate) => String(candidate.sheetId) === request.sheetId,
  );
  if (!sheet) throw new ForbiddenError("requested-sheet-not-found");

  const month = monthFromName(access.name);
  if (month === null) throw new NeedsRepairError("month-not-derivable");

  const config: AppConfig = {
    schemaVersion: 1,
    setupState: "ready",
    month,
    ownerEmail: access.ownerEmail ?? "",
    templateVersion: 1,
    statuses: FALLBACK_STATUSES,
    members: [],
  };

  return {
    role: "open",
    sheetId: sheet.sheetId,
    sheetTitle: sheet.title,
    config,
    month,
    dates: monthDates(month),
    spreadsheetTimeZone: normalizeSpreadsheetTimeZone(spreadsheet.timeZone),
  };
}

async function resolveTarget(
  dependencies: AttendanceDependencies,
  request: { fileId: string; actorEmail: string; sheetId: string },
): Promise<AttendanceTarget> {
  const repository = cachedConfigRepository(
    dependencies.config ?? createConfigRepository({ sheets: dependencies.sheets, drive: dependencies.drive }),
  );

  const role: FileRole = await authorizeFile(
    { drive: dependencies.drive, config: repository },
    { fileId: request.fileId, actorEmail: request.actorEmail, requestedSheetId: request.sheetId },
  );

  if (role.kind === "open") {
    return resolveOpenTarget(dependencies, request);
  }

  const { config, spreadsheet } = await readConfig(repository, request.fileId);
  const resolved =
    role.kind === "manager"
      ? resolveManagerSheet(config, spreadsheet, request.sheetId)
      : { sheetId: Number(role.sheetId), sheetTitle: role.sheetTitle };

  return {
    role: role.kind,
    ...resolved,
    config,
    month: config.month,
    dates: monthDates(config.month),
    // Reuses the snapshot the configuration read already fetched, so surfacing
    // the timezone costs no extra Sheets call.
    spreadsheetTimeZone: normalizeSpreadsheetTimeZone(spreadsheet.timeZone),
  };
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `GET` model for one member sheet and one configured month.
 *
 * Reads `A4:AS` for the month's actual day count and returns nothing about any
 * other member.
 */
export async function readAttendanceMonth(
  dependencies: AttendanceDependencies,
  request: ReadAttendanceRequest,
): Promise<AttendanceMonthView> {
  const target = await resolveTarget(dependencies, request);
  const lastRow = DATA_START_ROW + target.dates.length - 1;
  const range = `${quoteTitle(target.sheetTitle)}!A${DATA_START_ROW}:${WORK_SLOT_LAST_COLUMN}${lastRow}`;

  const [block] = await dependencies.sheets.getValues(request.fileId, [range]);
  const rows = block?.values ?? [];

  const days = target.dates.map((date, index) => {
    const row = rows[index] ?? [];
    if (!isDateCell(columnValue(row, COLUMN.date.index), date)) {
      throw new AttendanceError("sheet-structure", `column-a-mismatch:${date}`);
    }
    return toAttendanceDay(date, row, target.config.statuses);
  });

  return {
    fileId: request.fileId,
    sheetId: target.sheetId,
    sheetTitle: target.sheetTitle,
    month: target.month,
    spreadsheetTimeZone: target.spreadsheetTimeZone,
    role: target.role,
    statuses: target.config.statuses,
    days,
  };
}

/* -------------------------------------------------------------------------- */
/* Save                                                                        */
/* -------------------------------------------------------------------------- */

const SLOT_SET = new Set<string>(TIME_SLOTS);

/** Column letters whose content is free text and must never be interpreted. */
const RAW_COLUMNS = new Set<string>([
  COLUMN.notes.letter,
  ...WORK_SLOT_COLUMNS.map((column) => column.letter),
]);

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Rejects anything that is not an editable attendance cell before a value is
 * read. Unknown field keys, unknown status codes, and wrong value types all
 * fail here rather than reaching an A1 range.
 */
function validatePatches(patches: AttendancePatch[], statuses: readonly ConfigStatus[]): void {
  if (!Array.isArray(patches)) throw new AttendanceError("invalid-request", "patches-not-an-array");

  for (const patch of patches) {
    if (patch === null || typeof patch !== "object") {
      throw new AttendanceError("invalid-request", "patch-not-an-object");
    }

    switch (patch.field) {
      case "status": {
        if (!isNullableString(patch.baseline) || !isNullableString(patch.value)) {
          throw new AttendanceError("invalid-request", "status-not-a-code");
        }
        for (const code of [patch.baseline, patch.value]) {
          if (code !== null && !statuses.some((status) => status.code === code)) {
            throw new AttendanceError("invalid-request", "status-not-configured");
          }
        }
        break;
      }
      case "clockIn":
      case "clockOut": {
        if (!isNullableNumber(patch.baseline) || !isNullableNumber(patch.value)) {
          throw new AttendanceError("invalid-request", `${patch.field}-not-a-decimal-hour`);
        }
        break;
      }
      case "breakHours": {
        if (typeof patch.baseline !== "number" || typeof patch.value !== "number") {
          throw new AttendanceError("invalid-request", "break-not-a-number");
        }
        break;
      }
      case "notes": {
        if (typeof patch.baseline !== "string" || typeof patch.value !== "string") {
          throw new AttendanceError("invalid-request", "notes-not-text");
        }
        break;
      }
      case "slot": {
        if (!SLOT_SET.has(patch.slot)) {
          throw new AttendanceError("invalid-request", "slot-not-in-work-report");
        }
        if (typeof patch.baseline !== "string" || typeof patch.value !== "string") {
          throw new AttendanceError("invalid-request", "slot-not-text");
        }
        break;
      }
      default:
        // Columns A/B/C/H, another sheet, and any raw A1 range land here.
        throw new AttendanceError("invalid-request", "field-not-editable");
    }
  }
}

type PatchSide = "baseline" | "value";

/** Applies one side of every patch on top of the live sheet row. */
function applyPatches(day: AttendanceDay, patches: AttendancePatch[], side: PatchSide): AttendanceDay {
  const applied = patches.reduce<AttendanceDay>((current, patch) => {
    switch (patch.field) {
      case "status":
        return { ...current, statusCode: patch[side] };
      case "clockIn":
        return { ...current, clockIn: patch[side] };
      case "clockOut":
        return { ...current, clockOut: patch[side] };
      case "breakHours":
        return { ...current, breakHours: patch[side] };
      case "notes":
        return { ...current, notes: patch[side] };
      case "slot":
        return { ...current, slots: { ...current.slots, [patch.slot]: patch[side] } };
    }
  }, day);

  return {
    ...applied,
    lunchBreak:
      applied.breakHours === 1 && applied.slots["12:00"] === "" && applied.slots["12:30"] === "",
    workHours: calculateWorkHours(applied),
  };
}

/** Free text goes out as `RAW`; every other cell keeps the formula-safe default. */
function inputOptionFor(range: string): ValueInputOption | undefined {
  const letter = /^([A-Z]+)/.exec(range)?.[1];
  return letter !== undefined && RAW_COLUMNS.has(letter) ? "RAW" : undefined;
}

function toValuePatch(title: string, patch: CellPatch): ValuePatch {
  const inputOption = inputOptionFor(patch.range);

  return {
    range: `${quoteTitle(title)}!${patch.range}`,
    values: [[patch.value ?? ""]],
    ...(inputOption ? { inputOption } : {}),
  };
}

/** Resolves the 1-based sheet row for a date from column A, server-side. */
async function resolveRow(
  dependencies: AttendanceDependencies,
  fileId: string,
  target: AttendanceTarget,
  date: string,
): Promise<number> {
  const lastRow = DATA_START_ROW + target.dates.length - 1;
  const range = `${quoteTitle(target.sheetTitle)}!A${DATA_START_ROW}:A${lastRow}`;
  const [column] = await dependencies.sheets.getValues(fileId, [range]);

  const index = (column?.values ?? []).findIndex((row) => isDateCell(row[0], date));
  if (index < 0) throw new AttendanceError("sheet-structure", "date-row-missing");

  return DATA_START_ROW + index;
}

/**
 * `POST` handler core: validate, resolve the row, re-read the dirty cells, then
 * write the smallest batch.
 *
 * Last writer wins, as approved, but every dirty cell whose live value diverged
 * from the client's baseline is disclosed in `conflicts`. A change to a
 * different cell neither creates a conflict nor widens the write to the row.
 */
export async function saveAttendanceDay(
  dependencies: AttendanceDependencies,
  request: SaveAttendanceRequest,
): Promise<SaveAttendanceResult> {
  const target = await resolveTarget(dependencies, request);

  if (!DATE_PATTERN.test(request.date) || !target.dates.includes(request.date)) {
    throw new AttendanceError("invalid-request", "date-outside-configured-month");
  }
  validatePatches(request.patches, target.config.statuses);

  const row = await resolveRow(dependencies, request.fileId, target, request.date);

  // Re-read the row immediately before the update so conflicts are decided on
  // the live values rather than on anything cached by this request.
  const rowRange = `${quoteTitle(target.sheetTitle)}!A${row}:${WORK_SLOT_LAST_COLUMN}${row}`;
  const [live] = await dependencies.sheets.getValues(request.fileId, [rowRange]);
  const currentRow = live?.values?.[0] ?? [];
  if (!isDateCell(columnValue(currentRow, COLUMN.date.index), request.date)) {
    throw new AttendanceError("sheet-structure", "date-row-moved");
  }

  const current = toAttendanceDay(request.date, currentRow, target.config.statuses);
  const baseline = applyPatches(current, request.patches, "baseline");
  const next = applyPatches(current, request.patches, "value");

  const issues = validateAttendanceDay(next, target.config.statuses);
  if (issues.length > 0) throw new AttendanceError("invalid-day", "day-validation-failed", issues);

  const written = diffDay(baseline, next, row, target.config.statuses);
  const divergences = diffDay(baseline, current, row, target.config.statuses);
  const conflicts = written.flatMap<AttendanceConflict>((patch) => {
    const divergence = divergences.find((candidate) => candidate.range === patch.range);
    return divergence
      ? [{ range: patch.range, baseline: divergence.baseline, current: divergence.value }]
      : [];
  });

  if (written.length > 0) {
    await dependencies.sheets.updateValues(
      request.fileId,
      written.map((patch) => toValuePatch(target.sheetTitle, patch)),
    );
  }

  return { row, workHours: next.workHours, written, conflicts };
}
