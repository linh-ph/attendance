/**
 * Translation between the sheet's A1 columns and the wire's field keys.
 *
 * The dirty set is produced by `diffDay` — the same rule the server diffs with —
 * and then translated back here, so the browser never states a second opinion
 * about which cells changed. Column H has no key because it is a formula, and
 * A/B/C are generated.
 */

import type { AttendanceDay, TimeSlot } from "@/lib/attendance/model";
import { diffDay } from "@/lib/attendance/range-mapper";
import type { AttendanceMonthView, AttendancePatch } from "@/lib/attendance/service";
import { TIME_SLOTS } from "@/lib/attendance/slots";

/** Field key for each addressable summary column, mirroring the range mapper. */
const SUMMARY_FIELD_BY_COLUMN = {
  D: "status",
  E: "clockIn",
  F: "clockOut",
  G: "breakHours",
  I: "notes",
} as const;

export type SummaryColumn = keyof typeof SUMMARY_FIELD_BY_COLUMN;

/** `diffDay` writes the first work slot to column J. */
const FIRST_SLOT_COLUMN_INDEX = 10;

/** Any row works: only the column of each dirty range is read back. */
const DIFF_ROW = 1;

export function columnOf(range: string): string {
  return /^[A-Z]+/.exec(range)?.[0] ?? "";
}

function columnIndexOf(column: string): number {
  return [...column].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

export function slotOfColumn(column: string): TimeSlot | undefined {
  return TIME_SLOTS[columnIndexOf(column) - FIRST_SLOT_COLUMN_INDEX];
}

export function isSummaryColumn(column: string): column is SummaryColumn {
  return column in SUMMARY_FIELD_BY_COLUMN;
}

/**
 * The dirty cells as field-keyed patches, each with the baseline it was read
 * with so the server can disclose a last-writer conflict per cell.
 */
export function toPatches(
  baseline: AttendanceDay,
  draft: AttendanceDay,
  statuses: AttendanceMonthView["statuses"],
): AttendancePatch[] {
  return diffDay(baseline, draft, DIFF_ROW, statuses).flatMap<AttendancePatch>((patch) => {
    const column = columnOf(patch.range);

    if (isSummaryColumn(column)) {
      switch (SUMMARY_FIELD_BY_COLUMN[column]) {
        case "status":
          return [{ field: "status", baseline: baseline.statusCode, value: draft.statusCode }];
        case "clockIn":
          return [{ field: "clockIn", baseline: baseline.clockIn, value: draft.clockIn }];
        case "clockOut":
          return [{ field: "clockOut", baseline: baseline.clockOut, value: draft.clockOut }];
        case "breakHours":
          return [{ field: "breakHours", baseline: baseline.breakHours, value: draft.breakHours }];
        case "notes":
          return [{ field: "notes", baseline: baseline.notes, value: draft.notes }];
      }
    }

    const slot = slotOfColumn(column);
    return slot === undefined
      ? []
      : [{ field: "slot", slot, baseline: baseline.slots[slot], value: draft.slots[slot] }];
  });
}
