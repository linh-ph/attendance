import { Workbook } from "exceljs";
import type { Cell, CellValue, Worksheet } from "exceljs";
import { calculateWorkHours } from "@/lib/attendance/validation";
import {
  CONFIG_SHEET_TITLE,
  DATA_START_ROW,
  HEADER_CELLS,
  HEADER_RANGE,
  HOUR_MERGES,
  MINUTE_HEADERS,
  REFERENCE_COLUMN_BY_KEY,
  WORK_HOURS_FORMULA,
  WORK_SLOT_COLUMNS,
  HEADER_ROW,
  buildWorkHoursFormula,
} from "./contract";

export type WorkbookCheckCode =
  | "unsupported-file"
  | "file-too-large"
  | "missing-headers"
  | "invalid-hour-merges"
  | "invalid-minute-headers"
  | "month-mismatch"
  | "invalid-work-formula"
  | "unsupported-sheet";

export interface WorkbookInspection {
  sheets: Array<{ title: string; rowCount: number; month: string }>;
}

export class WorkbookCheckError extends Error {
  readonly code: WorkbookCheckCode;
  readonly sheetTitle: string | null;

  constructor(code: WorkbookCheckCode, message: string, sheetTitle: string | null = null) {
    super(message);
    this.name = "WorkbookCheckError";
    this.code = code;
    this.sheetTitle = sheetTitle;
  }
}

export const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const MACRO_ENTRY_NAME = "vbaProject.bin";
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/** Serials below 61 are ambiguous because of the Excel 1900 leap-year bug. */
const MIN_EXCEL_SERIAL = 61;
const WORK_HOUR_TOLERANCE = 1e-9;

const DATE_COLUMN = REFERENCE_COLUMN_BY_KEY.date.letter;
const CLOCK_IN_COLUMN = REFERENCE_COLUMN_BY_KEY.clockIn.letter;
const CLOCK_OUT_COLUMN = REFERENCE_COLUMN_BY_KEY.clockOut.letter;
const BREAK_COLUMN = REFERENCE_COLUMN_BY_KEY.breakHours.letter;
const WORK_HOURS_COLUMN = REFERENCE_COLUMN_BY_KEY.workHours.letter;

export async function inspectXlsx(input: Uint8Array | ArrayBuffer): Promise<WorkbookInspection> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assertSupportedFile(bytes);

  const workbook = await loadWorkbook(bytes);
  const sheets = workbook.worksheets
    .filter((worksheet) => worksheet.name !== CONFIG_SHEET_TITLE && worksheet.state === "visible")
    .map((worksheet) => inspectSheet(worksheet));

  if (sheets.length === 0) {
    throw new WorkbookCheckError("unsupported-file", "The workbook contains no attendance sheets.");
  }

  return { sheets };
}

function assertSupportedFile(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new WorkbookCheckError("file-too-large", "The workbook must be 20 MB or smaller.");
  }

  if (hasSignature(bytes, OLE_SIGNATURE)) {
    throw new WorkbookCheckError(
      "unsupported-file",
      "The workbook is encrypted or password protected. Remove the protection and upload it again.",
    );
  }

  if (!hasSignature(bytes, ZIP_SIGNATURE)) {
    throw new WorkbookCheckError("unsupported-file", "The file is not a valid .xlsx workbook.");
  }

  if (containsAscii(bytes, MACRO_ENTRY_NAME)) {
    throw new WorkbookCheckError(
      "unsupported-file",
      "Macro-enabled workbooks are not supported. Save the file as .xlsx and upload it again.",
    );
  }
}

async function loadWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const workbook = new Workbook();

  try {
    // ExcelJS types its reader input as an ArrayBuffer-like value; the bytes are read, never rewritten.
    await workbook.xlsx.load(bytes as unknown as Parameters<Workbook["xlsx"]["load"]>[0]);
  } catch {
    throw new WorkbookCheckError(
      "unsupported-file",
      "The workbook could not be read. Upload an unmodified .xlsx file.",
    );
  }

  return workbook;
}

function inspectSheet(worksheet: Worksheet): { title: string; rowCount: number; month: string } {
  const title = worksheet.name;
  const merges = readMerges(worksheet);

  if (!looksLikeEmployeeSheet(worksheet, merges)) {
    throw new WorkbookCheckError(
      "unsupported-sheet",
      "The workbook contains a sheet that is not an attendance sheet. Remove it and upload the file again.",
      title,
    );
  }

  assertHeaders(worksheet, title);
  assertHourMerges(worksheet, merges, title);
  assertMinuteHeaders(worksheet, title);

  const { rows, month } = readDateRows(worksheet, title);
  assertWorkHourFormulas(worksheet, rows, title);

  return { title, rowCount: rows.length, month };
}

function looksLikeEmployeeSheet(worksheet: Worksheet, merges: ReadonlySet<string>): boolean {
  if (HOUR_MERGES.some((merge) => merges.has(merge.range))) return true;
  return HEADER_CELLS.some((header) => readText(worksheet.getCell(header.cell)) === header.value);
}

function assertHeaders(worksheet: Worksheet, title: string): void {
  const matches = HEADER_CELLS.every(
    (header) => readText(worksheet.getCell(header.cell)) === header.value,
  );
  if (matches) return;

  throw new WorkbookCheckError(
    "missing-headers",
    `The header row ${HEADER_RANGE} does not match the attendance template.`,
    title,
  );
}

function assertHourMerges(worksheet: Worksheet, merges: ReadonlySet<string>, title: string): void {
  const matches = HOUR_MERGES.every((merge) => {
    if (!merges.has(merge.range)) return false;
    return readNumber(worksheet.getCell(merge.range.split(":")[0])) === merge.value;
  });
  if (matches) return;

  const first = HOUR_MERGES[0].range;
  const last = HOUR_MERGES[HOUR_MERGES.length - 1].range;
  throw new WorkbookCheckError(
    "invalid-hour-merges",
    `The hour headers must be merged from ${first} through ${last}.`,
    title,
  );
}

function assertMinuteHeaders(worksheet: Worksheet, title: string): void {
  const matches = WORK_SLOT_COLUMNS.every((column, offset) => {
    return readNumber(worksheet.getCell(`${column.letter}${HEADER_ROW}`)) === MINUTE_HEADERS[offset];
  });
  if (matches) return;

  throw new WorkbookCheckError(
    "invalid-minute-headers",
    `Row ${HEADER_ROW} must hold ${MINUTE_HEADERS.length} work-slot headers alternating between 0 and 30.`,
    title,
  );
}

function readDateRows(worksheet: Worksheet, title: string): { rows: number[]; month: string } {
  const rows: number[] = [];
  const months = new Set<string>();

  for (let row = DATA_START_ROW; row <= worksheet.rowCount; row += 1) {
    const cell = worksheet.getCell(`${DATE_COLUMN}${row}`);
    if (isBlank(cell)) continue;

    const monthKey = toMonthKey(cell.value);
    if (monthKey === null) break;

    rows.push(row);
    months.add(monthKey);
  }

  const [month] = [...months];
  if (months.size !== 1 || month === undefined) {
    throw new WorkbookCheckError(
      "month-mismatch",
      `Every date in column ${DATE_COLUMN} must be a calendar date in one single month.`,
      title,
    );
  }

  return { rows, month };
}

function assertWorkHourFormulas(worksheet: Worksheet, rows: readonly number[], title: string): void {
  const reconcilable = rows.every((row) => isReconcilableWorkHours(worksheet, row));
  if (reconcilable) return;

  throw new WorkbookCheckError(
    "invalid-work-formula",
    `Column ${WORK_HOURS_COLUMN} must be empty or equivalent to the ${WORK_HOURS_FORMULA} work-hour formula.`,
    title,
  );
}

function isReconcilableWorkHours(worksheet: Worksheet, row: number): boolean {
  const cell = worksheet.getCell(`${WORK_HOURS_COLUMN}${row}`);
  const formula = readFormula(cell);
  if (formula !== null) return normalizeFormula(formula) === buildWorkHoursFormula(row);
  if (isBlank(cell)) return true;

  const stored = readNumber(cell);
  if (stored === null) return false;

  const expected = calculateWorkHours({
    clockIn: readNumber(worksheet.getCell(`${CLOCK_IN_COLUMN}${row}`)) ?? 0,
    clockOut: readNumber(worksheet.getCell(`${CLOCK_OUT_COLUMN}${row}`)) ?? 0,
    breakHours: readNumber(worksheet.getCell(`${BREAK_COLUMN}${row}`)) ?? 0,
  });

  return expected !== null && Math.abs(stored - expected) < WORK_HOUR_TOLERANCE;
}

function normalizeFormula(formula: string): string {
  return formula.replace(/[\s$]/g, "").toUpperCase();
}

function readMerges(worksheet: Worksheet): ReadonlySet<string> {
  const merges = worksheet.model.merges ?? [];
  return new Set(merges.map((range) => range.replace(/\$/g, "").toUpperCase()));
}

function asRecord(value: CellValue): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || value instanceof Date) return null;
  return value as unknown as Record<string, unknown>;
}

function isBlank(cell: Cell): boolean {
  const value = cell.value;
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

function readFormula(cell: Cell): string | null {
  const record = asRecord(cell.value);
  if (record === null) return null;
  if (!("formula" in record) && !("sharedFormula" in record)) return null;
  return typeof cell.formula === "string" ? cell.formula : null;
}

function readText(cell: Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const record = asRecord(value);
  if (record === null) return "";
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.result === "string") return record.result.trim();
  if (Array.isArray(record.richText)) {
    return record.richText.map((part) => String((part as { text?: string }).text ?? "")).join("").trim();
  }

  return "";
}

function readNumber(cell: Cell): number | null {
  const value = cell.value;
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    return trimmed !== "" && Number.isFinite(parsed) ? parsed : null;
  }

  const record = asRecord(value);
  if (record !== null && typeof record.result === "number") return record.result;

  return null;
}

function toMonthKey(value: CellValue): string | null {
  const date = toUtcDate(value);
  if (date === null) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toUtcDate(value: CellValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return fromExcelSerial(value);

  if (typeof value === "string") {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value.trim());
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  const record = asRecord(value);
  if (record === null) return null;
  if (record.result instanceof Date || typeof record.result === "number") {
    return toUtcDate(record.result as CellValue);
  }

  return null;
}

function fromExcelSerial(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < MIN_EXCEL_SERIAL) return null;
  return new Date(EXCEL_EPOCH_UTC_MS + Math.floor(serial) * MS_PER_DAY);
}

function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  const limit = bytes.byteLength - target.byteLength;

  for (let index = 0; index <= limit; index += 1) {
    if (matchesAt(bytes, target, index)) return true;
  }

  return false;
}

function matchesAt(bytes: Uint8Array, target: Uint8Array, start: number): boolean {
  for (let offset = 0; offset < target.byteLength; offset += 1) {
    if (bytes[start + offset] !== target[offset]) return false;
  }

  return true;
}
