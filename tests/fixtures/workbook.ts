import { Workbook } from "exceljs";
import type { Worksheet, WorksheetState } from "exceljs";
import JSZip from "jszip";
import {
  CONFIG_SHEET_TITLE,
  DATA_START_ROW,
  FROZEN_PANE,
  HEADER_CELLS,
  HEADER_ROW,
  HOUR_MERGES,
  MINUTE_HEADERS,
  WORK_REPORT_HEADER,
  WORK_SLOT_COLUMNS,
  WORK_SLOT_FIRST_COLUMN,
  WORK_SLOT_LAST_COLUMN,
  buildWorkHoursFormula,
} from "@/lib/workbook/contract";

export const DEFAULT_FIXTURE_MONTH = "2026-07";
export const DEFAULT_SHEET_TITLES = ["Employee A", "Employee B"] as const;

/** Each mutation independently breaks exactly one contract rule on the first employee sheet. */
export type WorkbookMutation =
  | "break-headers"
  | "break-hour-merge"
  | "break-minute-header"
  | "break-month"
  | "break-work-formula";

/** Reconcilable ways the reference workbook can carry column H. */
export type WorkHoursMode = "shared-formula" | "static-values" | "blank";

export interface WorkbookFixtureOptions {
  month?: string;
  sheetTitles?: readonly string[];
  /** Column A can hold real dates or raw Excel serial numbers; both are valid workbook inputs. */
  dateFormat?: "date" | "serial";
  workHours?: WorkHoursMode;
  configSheetState?: "absent" | "hidden" | "visible";
  auxiliarySheetTitle?: string;
  mutation?: WorkbookMutation;
}

interface SheetBuildOptions {
  month: string;
  dateFormat: "date" | "serial";
  workHours: WorkHoursMode;
  mutation?: WorkbookMutation;
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const CLOCK_IN_DECIMAL = 9;
const CLOCK_OUT_DECIMAL = 18;
const BREAK_DECIMAL = 1;
const MUTATED_HOUR = 12;
const MUTATED_MINUTE_HEADER_OFFSET = 1;
const OFFICE_STATUS = "出社";

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`invalid fixture month: ${month}`);
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

export function daysInFixtureMonth(month: string): number {
  const { year, monthIndex } = parseMonth(month);
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function toExcelSerial(date: Date): number {
  return (date.getTime() - EXCEL_EPOCH_UTC_MS) / MS_PER_DAY;
}

function writeHourHeaders(worksheet: Worksheet, mutation?: WorkbookMutation): void {
  const skipped = mutation === "break-hour-merge"
    ? HOUR_MERGES.find((merge) => merge.value === MUTATED_HOUR)?.range
    : undefined;

  for (const merge of HOUR_MERGES) {
    if (merge.range !== skipped) worksheet.mergeCells(merge.range);
    worksheet.getCell(merge.range.split(":")[0]).value = merge.value;
  }
}

function writeMinuteHeaders(worksheet: Worksheet, mutation?: WorkbookMutation): void {
  WORK_SLOT_COLUMNS.forEach((column, offset) => {
    const broken = mutation === "break-minute-header" && offset === MUTATED_MINUTE_HEADER_OFFSET;
    worksheet.getCell(`${column.letter}${HEADER_ROW}`).value = broken ? 15 : MINUTE_HEADERS[offset];
  });
}

function writeColumnHeaders(worksheet: Worksheet, mutation?: WorkbookMutation): void {
  for (const header of HEADER_CELLS) {
    const broken = mutation === "break-headers" && header.key === "breakHours";
    worksheet.getCell(header.cell).value = broken ? "Break" : header.value;
  }
}

function writeDataRows(worksheet: Worksheet, options: SheetBuildOptions): void {
  const { year, monthIndex } = parseMonth(options.month);
  const total = daysInFixtureMonth(options.month);
  let businessDay = 0;

  for (let day = 1; day <= total; day += 1) {
    const row = DATA_START_ROW + day - 1;
    const outsideMonth = options.mutation === "break-month" && day === total;
    const date = outsideMonth
      ? new Date(Date.UTC(year, monthIndex + 1, 1))
      : new Date(Date.UTC(year, monthIndex, day));

    worksheet.getCell(`A${row}`).value = options.dateFormat === "serial" ? toExcelSerial(date) : date;
    worksheet.getCell(`B${row}`).value = WEEKDAY_LABELS[date.getUTCDay()];

    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    businessDay += 1;
    worksheet.getCell(`C${row}`).value = businessDay;
    worksheet.getCell(`D${row}`).value = OFFICE_STATUS;
    worksheet.getCell(`E${row}`).value = CLOCK_IN_DECIMAL;
    worksheet.getCell(`F${row}`).value = CLOCK_OUT_DECIMAL;
    worksheet.getCell(`G${row}`).value = BREAK_DECIMAL;
  }

  writeWorkHours(worksheet, DATA_START_ROW + total - 1, options);
}

function writeWorkHours(worksheet: Worksheet, lastRow: number, options: SheetBuildOptions): void {
  if (options.mutation === "break-work-formula") {
    for (let row = DATA_START_ROW; row <= lastRow; row += 1) {
      worksheet.getCell(`H${row}`).value = { formula: buildWorkHoursFormula(row), date1904: false };
    }

    const slotRange = `${WORK_SLOT_FIRST_COLUMN}${DATA_START_ROW}:${WORK_SLOT_LAST_COLUMN}${DATA_START_ROW}`;
    worksheet.getCell(`H${DATA_START_ROW}`).value = { formula: `SUM(${slotRange})`, date1904: false };
    return;
  }

  if (options.workHours === "blank") return;

  if (options.workHours === "static-values") {
    for (let row = DATA_START_ROW; row <= lastRow; row += 1) {
      const clockIn = readDecimal(worksheet, `E${row}`);
      const clockOut = readDecimal(worksheet, `F${row}`);
      worksheet.getCell(`H${row}`).value = clockOut - readDecimal(worksheet, `G${row}`) - clockIn;
    }
    return;
  }

  worksheet.fillFormula(`H${DATA_START_ROW}:H${lastRow}`, buildWorkHoursFormula(DATA_START_ROW));
}

function readDecimal(worksheet: Worksheet, address: string): number {
  const value = worksheet.getCell(address).value;
  return typeof value === "number" ? value : 0;
}

function addEmployeeSheet(workbook: Workbook, title: string, options: SheetBuildOptions): void {
  const worksheet = workbook.addWorksheet(title);
  worksheet.views = [{ state: "frozen", xSplit: FROZEN_PANE.columns, ySplit: FROZEN_PANE.rows }];

  worksheet.mergeCells(`${WORK_SLOT_FIRST_COLUMN}1:${WORK_SLOT_LAST_COLUMN}1`);
  worksheet.getCell(`${WORK_SLOT_FIRST_COLUMN}1`).value = WORK_REPORT_HEADER;

  writeHourHeaders(worksheet, options.mutation);
  writeMinuteHeaders(worksheet, options.mutation);
  writeColumnHeaders(worksheet, options.mutation);
  writeDataRows(worksheet, options);
}

function addAuxiliarySheet(workbook: Workbook, title: string): void {
  const worksheet = workbook.addWorksheet(title);
  worksheet.getCell("A1").value = "Monthly totals";
  worksheet.getCell("A2").value = 168;
}

function addConfigSheet(workbook: Workbook, state: WorksheetState): void {
  const worksheet = workbook.addWorksheet(CONFIG_SHEET_TITLE);
  worksheet.state = state;
  worksheet.getCell("A1").value = "month";
  worksheet.getCell("B1").value = "1999-01";
  worksheet.getCell("A2").value = "employeeEmail";
  worksheet.getCell("B2").value = "attacker@example.com";
}

export async function buildAttendanceWorkbookBuffer(
  options: WorkbookFixtureOptions = {},
): Promise<Buffer> {
  const month = options.month ?? DEFAULT_FIXTURE_MONTH;
  const dateFormat = options.dateFormat ?? "date";
  const workHours = options.workHours ?? "shared-formula";
  const titles = options.sheetTitles ?? DEFAULT_SHEET_TITLES;
  const workbook = new Workbook();

  titles.forEach((title, position) => {
    addEmployeeSheet(workbook, title, {
      month,
      dateFormat,
      workHours,
      mutation: position === 0 ? options.mutation : undefined,
    });
  });

  if (options.auxiliarySheetTitle) addAuxiliarySheet(workbook, options.auxiliarySheetTitle);

  const configSheetState = options.configSheetState ?? "absent";
  if (configSheetState !== "absent") addConfigSheet(workbook, configSheetState);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildNonXlsxBuffer(): Buffer {
  return Buffer.from("date,clock-in,clock-out\n2026-07-01,9,18\n", "utf8");
}

export async function buildCorruptZipBuffer(): Promise<Buffer> {
  const valid = await buildAttendanceWorkbookBuffer();
  return valid.subarray(0, Math.floor(valid.byteLength / 2));
}

/** Encrypted OOXML files are OLE2 compound documents rather than ZIP archives. */
export function buildEncryptedWorkbookBuffer(): Buffer {
  const buffer = Buffer.alloc(2048);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buffer);
  buffer.write("EncryptedPackage", 512, "utf8");
  return buffer;
}

export async function buildMacroEnabledWorkbookBuffer(): Promise<Buffer> {
  const valid = await buildAttendanceWorkbookBuffer();
  const archive = await JSZip.loadAsync(valid);
  archive.file("xl/vbaProject.bin", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return archive.generateAsync({ type: "nodebuffer" });
}

export function buildOversizeBuffer(limitBytes: number): Buffer {
  const buffer = Buffer.alloc(limitBytes + 1);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(buffer);
  return buffer;
}
