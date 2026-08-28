import type { AttendanceDay, StatusCode } from "./model";
import { TIME_SLOTS } from "./slots";

export interface CellPatch {
  range: string;
  baseline: string | number | null;
  value: string | number | null;
}

export interface ConfiguredStatus {
  code: string;
  sheetValue: string;
}

const SUMMARY_COLUMNS = {
  statusCode: "D",
  clockIn: "E",
  clockOut: "F",
  breakHours: "G",
  notes: "I",
} as const;

function columnName(index: number): string {
  let column = "";
  let remaining = index;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    column = String.fromCharCode("A".charCodeAt(0) + remainder) + column;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return column;
}

function sheetStatusValue(
  statusCode: StatusCode | null,
  configuredStatuses: ReadonlyArray<ConfiguredStatus>,
): string | null {
  if (statusCode === null) return null;
  const status = configuredStatuses.find((candidate) => candidate.code === statusCode);
  if (!status) throw new Error("unknown-status");
  return status.sheetValue;
}

export function diffDay(
  baseline: AttendanceDay,
  current: AttendanceDay,
  row: number,
  configuredStatuses: ReadonlyArray<ConfiguredStatus>,
): CellPatch[] {
  const patches: CellPatch[] = [];
  const summaryValues = [
    [
      SUMMARY_COLUMNS.statusCode,
      sheetStatusValue(baseline.statusCode, configuredStatuses),
      sheetStatusValue(current.statusCode, configuredStatuses),
    ],
    [SUMMARY_COLUMNS.clockIn, baseline.clockIn, current.clockIn],
    [SUMMARY_COLUMNS.clockOut, baseline.clockOut, current.clockOut],
    [SUMMARY_COLUMNS.breakHours, baseline.breakHours, current.breakHours],
    [SUMMARY_COLUMNS.notes, baseline.notes, current.notes],
  ] as const;

  for (const [column, previous, next] of summaryValues) {
    if (!Object.is(previous, next)) patches.push({ range: `${column}${row}`, baseline: previous, value: next });
  }

  for (const [index, slot] of TIME_SLOTS.entries()) {
    if (baseline.slots[slot] !== current.slots[slot]) {
      patches.push({ range: `${columnName(10 + index)}${row}`, baseline: baseline.slots[slot], value: current.slots[slot] });
    }
  }

  return patches;
}
