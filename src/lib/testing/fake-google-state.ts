/**
 * The in-memory shapes of the deterministic Drive/Sheets world, and the
 * primitives that build and address them.
 *
 * Everything that writes a cell — the seed, the `batchUpdate` request handlers,
 * and the value gateways — goes through `writeCell` here, so `maxRow` stays
 * correct no matter which path produced the value, and every A1 range is parsed
 * by one rule rather than per call site.
 */

import type { CellValue } from "@/lib/google/types";
import { DATA_START_ROW } from "@/lib/workbook/contract";

/* -------------------------------------------------------------------------- */
/* State shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface FakeProtectedRange {
  protectedRangeId: number;
  sheetId: number;
  editors: string[];
}

export interface FakeSheet {
  sheetId: number;
  title: string;
  hidden: boolean;
  protectedRanges: FakeProtectedRange[];
  /** `row:column`, both 1-based, to the stored value. */
  cells: Map<string, CellValue>;
  maxRow: number;
}

export interface FakeFolder {
  id: string;
  name: string;
  ownerEmail: string;
  trashed: boolean;
  canAddChildren: boolean;
  /** Any value makes this a Shared Drive folder, which is refused. */
  driveId: string | null;
}

export interface FakeFile {
  id: string;
  name: string;
  ownerEmail: string;
  folderId: string;
  trashed: boolean;
  mimeType: string;
  appProperties: Record<string, string>;
  /** Normalized emails Drive shared the file with, excluding the owner. */
  sharedWith: Set<string>;
  sheets: FakeSheet[];
}

export interface FakeFaults {
  /** Consumed one per `updateValues`, to prove the editor's retry state. */
  attendanceSaveFailures: number;
  /** Emails whose next Drive invitation fails. */
  inviteFailures: Set<string>;
}

export interface FakeGoogleStore {
  folders: Map<string, FakeFolder>;
  files: Map<string, FakeFile>;
  faults: FakeFaults;
  nextSheetId: number;
  nextProtectionId: number;
  nextPermissionId: number;
  nextFileId: number;
}

/** Created sheets and protections start far above every seeded identifier. */
export const FIRST_CREATED_SHEET_ID = 9000;
export const FIRST_CREATED_PROTECTION_ID = 8000;

/* -------------------------------------------------------------------------- */
/* A1 range arithmetic                                                         */
/* -------------------------------------------------------------------------- */

export interface ParsedRange {
  title: string;
  startRow: number;
  startColumn: number;
  /** `null` for an open-ended range such as `__APP_CONFIG!H1:N`. */
  endRow: number | null;
  endColumn: number;
}

const RANGE_PATTERN = /^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/;

export function columnIndex(letters: string): number {
  return [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

export function parseRange(range: string): ParsedRange {
  const match = RANGE_PATTERN.exec(range);
  if (!match) throw new Error(`The E2E sheet store cannot address "${range}".`);

  const startColumn = columnIndex(match[3]);
  const hasEndColumn = match[5] !== undefined;

  return {
    title: (match[1] ?? match[2]).replace(/''/g, "'"),
    startRow: Number(match[4]),
    startColumn,
    endRow: match[6] !== undefined ? Number(match[6]) : hasEndColumn ? null : Number(match[4]),
    endColumn: hasEndColumn ? columnIndex(match[5]) : startColumn,
  };
}

export function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

export function writeCell(sheet: FakeSheet, row: number, column: number, value: CellValue): void {
  sheet.cells.set(cellKey(row, column), value);
  sheet.maxRow = Math.max(sheet.maxRow, row);
}

/* -------------------------------------------------------------------------- */
/* Sheet writers                                                               */
/* -------------------------------------------------------------------------- */

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const SHEET_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function makeSheet(sheetId: number, title: string, hidden = false): FakeSheet {
  return { sheetId, title, hidden, protectedRanges: [], cells: new Map(), maxRow: 0 };
}

export function protect(sheet: FakeSheet, protectedRangeId: number, editors: string[]): void {
  sheet.protectedRanges.push({ protectedRangeId, sheetId: sheet.sheetId, editors });
}

/** Writes the generated columns A, B, and C for every day of a month. */
export function writeMonthGrid(sheet: FakeSheet, month: string): void {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  let businessDay = 0;

  for (let day = 1; day <= days; day += 1) {
    const date = new Date(Date.UTC(year, monthNumber - 1, day));
    const weekday = date.getUTCDay();
    const isBusinessDay = weekday !== 0 && weekday !== 6;
    const row = DATA_START_ROW + day - 1;

    writeCell(sheet, row, 1, (date.getTime() - SHEET_EPOCH_UTC_MS) / MS_PER_DAY);
    writeCell(sheet, row, 2, WEEKDAY_LABELS[weekday]);
    writeCell(sheet, row, 3, isBusinessDay ? (businessDay += 1) : "");
  }
}
