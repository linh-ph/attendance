import type { TimeSlot } from "@/lib/attendance/model";
import { TIME_SLOTS } from "@/lib/attendance/slots";

export const CONFIG_SHEET_TITLE = "__APP_CONFIG";

export const HOUR_HEADER_ROW = 2;
export const HEADER_ROW = 3;
export const DATA_START_ROW = 4;

export const FROZEN_PANE = { rows: 3, columns: 2 } as const;

export type ReferenceColumnKey =
  | "date"
  | "weekday"
  | "businessDay"
  | "status"
  | "clockIn"
  | "clockOut"
  | "breakHours"
  | "workHours"
  | "notes";

export interface ReferenceColumn {
  key: ReferenceColumnKey;
  letter: string;
  index: number;
  sheetHeader: string | null;
}

export const REFERENCE_COLUMNS: readonly ReferenceColumn[] = [
  { key: "date", letter: "A", index: 1, sheetHeader: null },
  { key: "weekday", letter: "B", index: 2, sheetHeader: null },
  { key: "businessDay", letter: "C", index: 3, sheetHeader: "営業日" },
  { key: "status", letter: "D", index: 4, sheetHeader: "ステータス" },
  { key: "clockIn", letter: "E", index: 5, sheetHeader: "出勤" },
  { key: "clockOut", letter: "F", index: 6, sheetHeader: "退勤" },
  { key: "breakHours", letter: "G", index: 7, sheetHeader: "休憩" },
  { key: "workHours", letter: "H", index: 8, sheetHeader: "労働時間" },
  { key: "notes", letter: "I", index: 9, sheetHeader: "備考" },
];

export const REFERENCE_COLUMN_BY_KEY = Object.fromEntries(
  REFERENCE_COLUMNS.map((column) => [column.key, column]),
) as Readonly<Record<ReferenceColumnKey, ReferenceColumn>>;

/** Column keys whose Japanese header is written on the header row (D3:I3). */
export const HEADER_COLUMN_KEYS = [
  "status",
  "clockIn",
  "clockOut",
  "breakHours",
  "workHours",
  "notes",
] as const satisfies readonly ReferenceColumnKey[];

export interface HeaderCell {
  key: ReferenceColumnKey;
  letter: string;
  index: number;
  cell: string;
  value: string;
}

export const HEADER_CELLS: readonly HeaderCell[] = HEADER_COLUMN_KEYS.map((key) => {
  const column = REFERENCE_COLUMN_BY_KEY[key];
  return {
    key,
    letter: column.letter,
    index: column.index,
    cell: `${column.letter}${HEADER_ROW}`,
    value: column.sheetHeader ?? "",
  };
});

export const HEADER_RANGE = `${HEADER_CELLS[0].cell}:${HEADER_CELLS[HEADER_CELLS.length - 1].cell}`;

export const WORK_REPORT_HEADER = "作業時間報告";

export const FIRST_WORK_HOUR = 6;
export const LAST_WORK_HOUR = 23;
export const WORK_SLOT_COUNT = TIME_SLOTS.length;
export const WORK_SLOT_FIRST_COLUMN_INDEX = 10;
export const WORK_SLOT_LAST_COLUMN_INDEX = WORK_SLOT_FIRST_COLUMN_INDEX + WORK_SLOT_COUNT - 1;

export function toColumnLetter(index: number): string {
  let remaining = index;
  let letters = "";

  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = `${String.fromCharCode(65 + offset)}${letters}`;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return letters;
}

export function toColumnIndex(letter: string): number {
  let index = 0;

  for (const character of letter.toUpperCase()) {
    const offset = character.charCodeAt(0) - 64;
    if (offset < 1 || offset > 26) return 0;
    index = index * 26 + offset;
  }

  return index;
}

export const WORK_SLOT_FIRST_COLUMN = toColumnLetter(WORK_SLOT_FIRST_COLUMN_INDEX);
export const WORK_SLOT_LAST_COLUMN = toColumnLetter(WORK_SLOT_LAST_COLUMN_INDEX);

export interface WorkSlotColumn {
  slot: TimeSlot;
  hour: number;
  minute: 0 | 30;
  letter: string;
  index: number;
}

export const WORK_SLOT_COLUMNS: readonly WorkSlotColumn[] = TIME_SLOTS.map((slot, offset) => {
  const index = WORK_SLOT_FIRST_COLUMN_INDEX + offset;
  return {
    slot,
    hour: FIRST_WORK_HOUR + Math.floor(offset / 2),
    minute: offset % 2 === 0 ? 0 : 30,
    letter: toColumnLetter(index),
    index,
  };
});

export const MINUTE_HEADERS: readonly number[] = WORK_SLOT_COLUMNS.map((column) => column.minute);

export interface HourMerge {
  range: string;
  value: number;
}

export const HOUR_MERGES: readonly HourMerge[] = Array.from(
  { length: LAST_WORK_HOUR - FIRST_WORK_HOUR + 1 },
  (_, offset) => {
    const value = FIRST_WORK_HOUR + offset;
    const startIndex = WORK_SLOT_FIRST_COLUMN_INDEX + offset * 2;
    const start = `${toColumnLetter(startIndex)}${HOUR_HEADER_ROW}`;
    const end = `${toColumnLetter(startIndex + 1)}${HOUR_HEADER_ROW}`;
    return { range: `${start}:${end}`, value };
  },
);

export const WORK_HOURS_FORMULA = "F-G-E";

export function buildWorkHoursFormula(row: number): string {
  const clockIn = REFERENCE_COLUMN_BY_KEY.clockIn.letter;
  const clockOut = REFERENCE_COLUMN_BY_KEY.clockOut.letter;
  const breakHours = REFERENCE_COLUMN_BY_KEY.breakHours.letter;
  return `${clockOut}${row}-${breakHours}${row}-${clockIn}${row}`;
}
