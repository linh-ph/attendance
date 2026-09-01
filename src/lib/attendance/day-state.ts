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
 * Statuses that answer the day on their own.
 *
 * Somebody marked absent has nothing to report, so the absence of a work report
 * is the correct state for that day, not a gap. `出社` / `office` is the
 * opposite: it is the template's default and says nothing about whether the
 * person actually recorded anything.
 */
const SELF_ANSWERING_STATUSES: ReadonlySet<string> = new Set(["absent"]);

/**
 * Whether the day carries an attendance record.
 *
 * **The work report decides.** Columns E/F/G — clock in, clock out, break — and
 * a plain `office` status arrive pre-filled from the monthly template: measured
 * on the real workbook, every one of August's 21 working days carried an
 * identical `office / 08:00 / 17:00 / 1`, while the J:AS work report was filled
 * on 20 of them. Counting the clock columns therefore marked a day recorded
 * before anybody had touched it, and the one genuinely empty day — 2026-08-31 —
 * was indistinguishable from the twenty finished ones.
 *
 * So a day is recorded when it has:
 *
 * - any work-report slot filled — the thing a person actually enters daily; or
 * - a note; or
 * - a self-answering status such as `absent`.
 *
 * Deliberately *not* carriers:
 *
 * - `clockIn` / `clockOut` / `breakHours` — template values, see above.
 * - a plain `office` status — likewise.
 * - `workHours`, column H's `=F-G-E`, which is derived and never written here.
 * - `lunchBreak`, inferred on read from the break and the two noon slots.
 *
 * **Limit worth knowing:** a team that records only clock in and out and never
 * uses the work report would read as entirely unrecorded. Both real months use
 * the work report on every recorded day, but this is the assumption to revisit
 * if another member works differently.
 */
export function dayRecordState(day: AttendanceDay): DayRecordState {
  const recorded =
    (day.statusCode !== null && SELF_ANSWERING_STATUSES.has(day.statusCode)) ||
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
