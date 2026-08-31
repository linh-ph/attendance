/**
 * Deterministic monthly sheet template.
 *
 * Every export here is pure: it builds Google Sheets `batchUpdate` request
 * objects and value patches without touching the network. All ranges address
 * the numeric sheet id; titles are display values only.
 */

import { STATUS_OPTIONS } from "@/lib/attendance/model";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  serializeAppConfig,
  type AppConfig,
  type ConfigStatus,
} from "@/lib/config/schema";
import type { SheetRequest, ValuePatch } from "@/lib/google/types";
import {
  DATA_START_ROW,
  FROZEN_PANE,
  HEADER_CELLS,
  HEADER_ROW,
  HOUR_HEADER_ROW,
  HOUR_MERGES,
  MINUTE_HEADERS,
  REFERENCE_COLUMN_BY_KEY,
  WORK_REPORT_HEADER,
  WORK_SLOT_COLUMNS,
  WORK_SLOT_FIRST_COLUMN,
  WORK_SLOT_LAST_COLUMN,
  COLUMN_WIDTHS,
  TEMPLATE_FONT_FAMILY,
  WORK_SLOT_FIRST_COLUMN_INDEX,
  WORK_SLOT_LAST_COLUMN_INDEX,
  buildWorkHoursFormula,
  type HeaderCell,
  type HourMerge,
  type WorkSlotColumn,
} from "./contract";

/** Bumped whenever generated sheets stop matching previously created files. */
export const TEMPLATE_VERSION = 1;

export const MAX_SHEET_TITLE_LENGTH = 100;

/** Characters Google Sheets rejects inside a sheet title. */
export const FORBIDDEN_SHEET_TITLE_CHARACTERS = [":", "\\", "/", "?", "*", "[", "]"] as const;

/** Column B of the reference workbook stores the Japanese weekday character. */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The merged `作業時間報告` banner sits above the hour header row. */
const WORK_REPORT_HEADER_ROW = 1;

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

const SUNDAY = 0;
const SATURDAY = 6;

/**
 * Clock and work-hour cells hold decimal hours exactly like the reference
 * workbook (`8` is 08:00, `17.5` is 17:30). They must never be formatted as
 * spreadsheet time fractions.
 */
const DECIMAL_HOUR_NUMBER_FORMAT = { type: "NUMBER", pattern: "0.##" } as const;
const DATE_NUMBER_FORMAT = { type: "DATE", pattern: "yyyy-mm-dd" } as const;
const NUMBER_FORMAT_FIELDS = "userEnteredFormat.numberFormat";

/* -------------------------------------------------------------------------- */
/* Sheet titles                                                                */
/* -------------------------------------------------------------------------- */

export type SheetTitleIssueCode =
  | "empty-title"
  | "title-too-long"
  | "invalid-title-character"
  | "reserved-title"
  | "duplicate-title";

export class SheetTitleError extends Error {
  readonly code: SheetTitleIssueCode;
  readonly title: string;

  constructor(code: SheetTitleIssueCode, title: string, message: string) {
    super(message);
    this.name = "SheetTitleError";
    this.code = code;
    this.title = title;
  }
}

export function isSheetTitleError(value: unknown): value is SheetTitleError {
  return value instanceof SheetTitleError;
}

/** Comparison key used for uniqueness: NFC, case-folded, whitespace-collapsed. */
export function normalizeSheetTitleKey(title: string): string {
  return title.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** The sheet title for one member: the trimmed display name, validated. */
export function buildEmployeeSheetTitle(displayName: string): string {
  const title = displayName.trim();

  if (title === "") {
    throw new SheetTitleError("empty-title", title, "An employee sheet title cannot be empty.");
  }
  if (title.length > MAX_SHEET_TITLE_LENGTH) {
    throw new SheetTitleError(
      "title-too-long",
      title,
      `An employee sheet title cannot exceed ${MAX_SHEET_TITLE_LENGTH} characters.`,
    );
  }

  const forbidden = FORBIDDEN_SHEET_TITLE_CHARACTERS.find((character) => title.includes(character));
  if (forbidden !== undefined) {
    throw new SheetTitleError(
      "invalid-title-character",
      title,
      `An employee sheet title cannot contain "${forbidden}".`,
    );
  }

  if (normalizeSheetTitleKey(title) === normalizeSheetTitleKey(CONFIG_SHEET_TITLE)) {
    throw new SheetTitleError(
      "reserved-title",
      title,
      `"${CONFIG_SHEET_TITLE}" is reserved for the configuration sheet.`,
    );
  }

  return title;
}

/** Validates a whole roster so duplicate tabs are rejected before any mutation. */
export function buildEmployeeSheetTitles(displayNames: readonly string[]): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (const displayName of displayNames) {
    const title = buildEmployeeSheetTitle(displayName);
    const key = normalizeSheetTitleKey(title);
    if (seen.has(key)) {
      throw new SheetTitleError(
        "duplicate-title",
        title,
        `Employee sheet title "${title}" is already used by another member.`,
      );
    }

    seen.add(key);
    titles.push(title);
  }

  return titles;
}

/* -------------------------------------------------------------------------- */
/* Monthly employee sheet                                                      */
/* -------------------------------------------------------------------------- */

export interface TemplateRow {
  /** ISO calendar date written to column A, for example `2026-07-01`. */
  date: string;
  /** 1-based sheet row holding this date. */
  row: number;
  /** 0 = Sunday through 6 = Saturday, evaluated in UTC. */
  weekdayIndex: number;
  /** Japanese weekday character written to column B. */
  weekday: string;
  /** Monday-Friday sequence written to column C; `null` on Saturday and Sunday. */
  businessDay: number | null;
  isBusinessDay: boolean;
  /** Sheet-ready column-H formula such as `=F4-G4-E4`; `null` on weekends. */
  workHoursFormula: string | null;
}

export interface FrozenPane {
  rows: number;
  columns: number;
}

export interface GridSize {
  rowCount: number;
  columnCount: number;
}

export interface WorkReportBanner {
  range: string;
  value: string;
}

export interface EmployeeSheetPlanInput {
  /** Numeric Google sheet id; the sheet title is never an identity key. */
  sheetId: number;
  /** `YYYY-MM`. */
  month: string;
  /** Defaults to the built-in status enum from the reference workbook. */
  statuses?: readonly ConfigStatus[];
}

export interface EmployeeSheetPlan {
  sheetId: number;
  month: string;
  templateVersion: number;
  rows: readonly TemplateRow[];
  headerCells: readonly HeaderCell[];
  workReportHeader: WorkReportBanner;
  hourMerges: readonly HourMerge[];
  minuteHeaders: readonly number[];
  workColumns: readonly WorkSlotColumn[];
  frozenPane: FrozenPane;
  gridSize: GridSize;
  statuses: readonly ConfigStatus[];
  /** Ordered `spreadsheets.batchUpdate` requests. */
  requests: readonly SheetRequest[];
}

interface GridRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

type CellData = Record<string, unknown>;

const DEFAULT_STATUSES: readonly ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error("invalid-month");
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Spreadsheet serial number for a calendar date (1899-12-30 epoch). */
function toSerialDate(date: Date): number {
  return (date.getTime() - EXCEL_EPOCH_UTC_MS) / MS_PER_DAY;
}

function gridRange(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): GridRange {
  return { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex };
}

function cell(userEnteredValue: CellData | null): CellData {
  return userEnteredValue === null ? {} : { userEnteredValue };
}

function updateCells(range: GridRange, rows: readonly (readonly CellData[])[]): SheetRequest {
  return {
    updateCells: {
      range,
      rows: rows.map((values) => ({ values: [...values] })),
      fields: "userEnteredValue",
    },
  };
}

function mergeCells(range: GridRange): SheetRequest {
  return { mergeCells: { range, mergeType: "MERGE_ALL" } };
}

function numberFormat(range: GridRange, format: { type: string; pattern: string }): SheetRequest {
  return {
    repeatCell: {
      range,
      cell: { userEnteredFormat: { numberFormat: { ...format } } },
      fields: NUMBER_FORMAT_FIELDS,
    },
  };
}

function statusValidation(range: GridRange, statuses: readonly ConfigStatus[]): SheetRequest {
  return {
    setDataValidation: {
      range,
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: statuses.map((status) => ({ userEnteredValue: status.sheetValue })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  };
}

function buildRows(month: string): TemplateRow[] {
  const { year, monthIndex } = parseMonth(month);
  const total = daysInMonth(year, monthIndex);
  const rows: TemplateRow[] = [];
  let businessDay = 0;

  for (let day = 1; day <= total; day += 1) {
    const date = new Date(Date.UTC(year, monthIndex, day));
    const weekdayIndex = date.getUTCDay();
    const isBusinessDay = weekdayIndex !== SUNDAY && weekdayIndex !== SATURDAY;
    const row = DATA_START_ROW + day - 1;
    if (isBusinessDay) businessDay += 1;

    rows.push({
      date: toIsoDate(date),
      row,
      weekdayIndex,
      weekday: WEEKDAY_LABELS[weekdayIndex],
      businessDay: isBusinessDay ? businessDay : null,
      isBusinessDay,
      workHoursFormula: isBusinessDay ? `=${buildWorkHoursFormula(row)}` : null,
    });
  }

  return rows;
}

/** Contiguous `[startRowIndex, endRowIndex)` spans of business-day rows. */
function businessDaySpans(rows: readonly TemplateRow[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  for (const row of rows) {
    if (!row.isBusinessDay) continue;

    const index = row.row - 1;
    const last = spans.at(-1);
    if (last && last[1] === index) last[1] = index + 1;
    else spans.push([index, index + 1]);
  }

  return spans;
}

function buildHeaderRequests(sheetId: number): SheetRequest[] {
  const bannerRange = gridRange(
    sheetId,
    WORK_REPORT_HEADER_ROW - 1,
    WORK_REPORT_HEADER_ROW,
    WORK_SLOT_FIRST_COLUMN_INDEX - 1,
    WORK_SLOT_LAST_COLUMN_INDEX,
  );
  const bannerCellRange = gridRange(
    sheetId,
    WORK_REPORT_HEADER_ROW - 1,
    WORK_REPORT_HEADER_ROW,
    WORK_SLOT_FIRST_COLUMN_INDEX - 1,
    WORK_SLOT_FIRST_COLUMN_INDEX,
  );

  const hourRow = WORK_SLOT_COLUMNS.map((column) =>
    column.minute === 0 ? cell({ numberValue: column.hour }) : cell(null),
  );
  const hourRange = gridRange(
    sheetId,
    HOUR_HEADER_ROW - 1,
    HOUR_HEADER_ROW,
    WORK_SLOT_FIRST_COLUMN_INDEX - 1,
    WORK_SLOT_LAST_COLUMN_INDEX,
  );

  const headerRange = gridRange(
    sheetId,
    HEADER_ROW - 1,
    HEADER_ROW,
    HEADER_CELLS[0].index - 1,
    HEADER_CELLS[HEADER_CELLS.length - 1].index,
  );
  const minuteRange = gridRange(
    sheetId,
    HEADER_ROW - 1,
    HEADER_ROW,
    WORK_SLOT_FIRST_COLUMN_INDEX - 1,
    WORK_SLOT_LAST_COLUMN_INDEX,
  );

  return [
    updateCells(bannerCellRange, [[cell({ stringValue: WORK_REPORT_HEADER })]]),
    mergeCells(bannerRange),
    updateCells(hourRange, [hourRow]),
    ...HOUR_MERGES.map((merge, offset) => {
      const start = WORK_SLOT_FIRST_COLUMN_INDEX - 1 + offset * 2;
      return mergeCells(gridRange(sheetId, HOUR_HEADER_ROW - 1, HOUR_HEADER_ROW, start, start + 2));
    }),
    updateCells(headerRange, [HEADER_CELLS.map((header) => cell({ stringValue: header.value }))]),
    updateCells(minuteRange, [MINUTE_HEADERS.map((minute) => cell({ numberValue: minute }))]),
  ];
}

function buildDataRequests(sheetId: number, rows: readonly TemplateRow[]): SheetRequest[] {
  const firstRowIndex = DATA_START_ROW - 1;
  const lastRowIndex = firstRowIndex + rows.length;

  const dateColumn = REFERENCE_COLUMN_BY_KEY.date;
  const businessDayColumn = REFERENCE_COLUMN_BY_KEY.businessDay;
  const workHoursColumn = REFERENCE_COLUMN_BY_KEY.workHours;

  const calendarRange = gridRange(
    sheetId,
    firstRowIndex,
    lastRowIndex,
    dateColumn.index - 1,
    businessDayColumn.index,
  );
  const calendarRows = rows.map((row) => [
    cell({ numberValue: toSerialDate(new Date(`${row.date}T00:00:00.000Z`)) }),
    cell({ stringValue: row.weekday }),
    row.businessDay === null ? cell(null) : cell({ numberValue: row.businessDay }),
  ]);

  const workHoursRange = gridRange(
    sheetId,
    firstRowIndex,
    lastRowIndex,
    workHoursColumn.index - 1,
    workHoursColumn.index,
  );
  const workHoursRows = rows.map((row) => [
    row.workHoursFormula === null ? cell(null) : cell({ formulaValue: row.workHoursFormula }),
  ]);

  return [
    updateCells(calendarRange, calendarRows),
    updateCells(workHoursRange, workHoursRows),
  ];
}

/**
 * The look of the supplied workbook, applied to a tab this app creates.
 *
 * Two things only, because that is all the reference file actually carries:
 * Arial everywhere, and its column widths. It uses no fills and no borders, so
 * neither is invented here — a created tab should be recognisable as the same
 * document, not a redesign of it.
 *
 * The font is set across the whole grid rather than per range so a row added
 * later inherits it, and `fields` names exactly the one property being written
 * so nothing else about a cell's format is touched.
 */
function buildStyleRequests(sheetId: number, gridSize: GridSize): SheetRequest[] {
  return [
    {
      repeatCell: {
        range: gridRange(sheetId, 0, gridSize.rowCount, 0, gridSize.columnCount),
        cell: { userEnteredFormat: { textFormat: { fontFamily: TEMPLATE_FONT_FAMILY } } },
        fields: "userEnteredFormat.textFormat.fontFamily",
      },
    },
    ...COLUMN_WIDTHS.map((width) => ({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: width.firstColumn - 1,
          endIndex: width.lastColumn,
        },
        properties: { pixelSize: width.pixels },
        fields: "pixelSize",
      },
    })),
  ];
}

function buildFormatRequests(sheetId: number, rows: readonly TemplateRow[]): SheetRequest[] {
  const firstRowIndex = DATA_START_ROW - 1;
  const lastRowIndex = firstRowIndex + rows.length;
  const dateColumn = REFERENCE_COLUMN_BY_KEY.date;
  const clockInColumn = REFERENCE_COLUMN_BY_KEY.clockIn;
  const workHoursColumn = REFERENCE_COLUMN_BY_KEY.workHours;

  return [
    numberFormat(
      gridRange(sheetId, firstRowIndex, lastRowIndex, dateColumn.index - 1, dateColumn.index),
      DATE_NUMBER_FORMAT,
    ),
    numberFormat(
      gridRange(
        sheetId,
        firstRowIndex,
        lastRowIndex,
        clockInColumn.index - 1,
        workHoursColumn.index,
      ),
      DECIMAL_HOUR_NUMBER_FORMAT,
    ),
  ];
}

/**
 * Builds every request needed to turn one empty sheet into a monthly attendance
 * tab. Attendance input cells (D:G, I, J:AS) stay blank; column H is filled with
 * the `=F-G-E` formula rather than a calculated value.
 */
export function buildEmployeeSheetPlan(input: EmployeeSheetPlanInput): EmployeeSheetPlan {
  const { sheetId, month } = input;
  const statuses = input.statuses ?? DEFAULT_STATUSES;
  const rows = buildRows(month);
  const statusColumn = REFERENCE_COLUMN_BY_KEY.status;

  const gridSize: GridSize = {
    rowCount: DATA_START_ROW + rows.length - 1,
    columnCount: WORK_SLOT_LAST_COLUMN_INDEX,
  };

  const requests: SheetRequest[] = [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            rowCount: gridSize.rowCount,
            columnCount: gridSize.columnCount,
            frozenRowCount: FROZEN_PANE.rows,
            frozenColumnCount: FROZEN_PANE.columns,
          },
        },
        fields:
          "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    ...buildStyleRequests(sheetId, gridSize),
    ...buildHeaderRequests(sheetId),
    ...buildDataRequests(sheetId, rows),
    ...buildFormatRequests(sheetId, rows),
    ...businessDaySpans(rows).map(([start, end]) =>
      statusValidation(
        gridRange(sheetId, start, end, statusColumn.index - 1, statusColumn.index),
        statuses,
      ),
    ),
  ];

  return {
    sheetId,
    month,
    templateVersion: TEMPLATE_VERSION,
    rows,
    headerCells: HEADER_CELLS,
    workReportHeader: {
      range: `${WORK_SLOT_FIRST_COLUMN}${WORK_REPORT_HEADER_ROW}:${WORK_SLOT_LAST_COLUMN}${WORK_REPORT_HEADER_ROW}`,
      value: WORK_REPORT_HEADER,
    },
    hourMerges: HOUR_MERGES,
    minuteHeaders: MINUTE_HEADERS,
    workColumns: WORK_SLOT_COLUMNS,
    frozenPane: { rows: FROZEN_PANE.rows, columns: FROZEN_PANE.columns },
    gridSize,
    statuses,
    requests,
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration sheet                                                         */
/* -------------------------------------------------------------------------- */

export interface ConfigSheetPlanInput {
  /** Numeric sheet id of the `__APP_CONFIG` tab. */
  sheetId: number;
  config: AppConfig;
}

export interface ConfigSheetPlan {
  sheetId: number;
  title: string;
  /** Value patches for the reserved settings, status, and member ranges. */
  patches: readonly ValuePatch[];
  /** Batch requests that keep the configuration sheet hidden. */
  requests: readonly SheetRequest[];
}

/** Owns only the reserved `__APP_CONFIG` coordinates declared in the config schema. */
export function buildConfigSheetPlan({ sheetId, config }: ConfigSheetPlanInput): ConfigSheetPlan {
  const serialized = serializeAppConfig(config);

  return {
    sheetId,
    title: CONFIG_SHEET_TITLE,
    patches: [
      { range: CONFIG_SETTINGS_RANGE, values: serialized.settings },
      { range: CONFIG_STATUS_RANGE, values: serialized.statuses },
      { range: CONFIG_MEMBER_RANGE, values: serialized.members },
    ],
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId, hidden: true },
          fields: "hidden",
        },
      },
    ],
  };
}
