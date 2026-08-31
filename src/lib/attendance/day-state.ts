/**
 * One definition of "does this date have anything in it".
 *
 * The calendar, the day preview, and the day editor must agree, so the rule
 * lives here once. The vocabulary is exactly two values: a day is `recorded`
 * when at least one attendance value exists on it, and `not-recorded`
 * otherwise.
 *
 * There is deliberately no `Complete` state. Completion would have to be
 * defined for every configured status — including Absent, where an empty clock
 * pair is the correct answer — and no product rule says what that means. Adding
 * a third value here would invent that rule.
 *
 * Non-working days are orthogonal: a Saturday can be recorded, and a weekday
 * the calendar context marks non-working can be empty. They are reported
 * separately so the calendar can layer both.
 *
 * Pure: no I/O, no React, no Google types.
 */

import { fromIsoDate } from "./iso-date";
import type { AttendanceDay } from "./model";

export type DayRecordState = "recorded" | "not-recorded";

function hasText(value: string): boolean {
  return value.trim() !== "";
}

/**
 * Whether the day carries any attendance value.
 *
 * Six independent carriers: status, clock in, clock out, a non-zero break,
 * notes, and any work-report slot. Two fields are deliberately *not* carriers:
 *
 * - `workHours` is column H, the `=F-G-E` formula this app never writes. A
 *   value read back from it is derived, not entered.
 * - `lunchBreak` is inferred on read from the break plus the two noon slots, so
 *   counting it would double-count `breakHours`.
 */
export function dayRecordState(day: AttendanceDay): DayRecordState {
  const recorded =
    day.statusCode !== null ||
    day.clockIn !== null ||
    day.clockOut !== null ||
    day.breakHours !== 0 ||
    hasText(day.notes) ||
    Object.values(day.slots).some(hasText);

  return recorded ? "recorded" : "not-recorded";
}

/** Why the calendar shows a date as non-working. */
export type NonWorkingDaySource = "weekend" | "calendar-context";

export interface NonWorkingDayContext {
  /**
   * `YYYY-MM-DD` dates the calendar or workbook context marks non-working —
   * a holiday, a closure, or a `営業日` cell the file says is not a business
   * day. Supplied by the caller; this module owns no holiday list.
   */
  nonWorkingDates?: readonly string[];
  /**
   * Weekday indexes counted as the weekend, `0` = Sunday. Defaults to Saturday
   * and Sunday; a context with a different working week overrides it.
   */
  weekendDays?: readonly number[];
}

const DEFAULT_WEEKEND_DAYS: readonly number[] = [0, 6];

/**
 * The reason `date` is non-working, or `null` when it is a working day.
 *
 * The weekend wins when a date is both, because that is the marker the reader
 * recognizes without consulting the legend. The weekday comes from the calendar
 * date itself through `fromIsoDate`, which builds a local-field `Date`, so the
 * answer does not shift with the device timezone.
 */
export function nonWorkingDaySource(
  date: string,
  context: NonWorkingDayContext = {},
): NonWorkingDaySource | null {
  const parsed = fromIsoDate(date);
  if (parsed === null) return null;

  const weekendDays = context.weekendDays ?? DEFAULT_WEEKEND_DAYS;
  if (weekendDays.includes(parsed.getDay())) return "weekend";

  return context.nonWorkingDates?.includes(date) === true ? "calendar-context" : null;
}

export function isNonWorkingDay(date: string, context: NonWorkingDayContext = {}): boolean {
  return nonWorkingDaySource(date, context) !== null;
}
