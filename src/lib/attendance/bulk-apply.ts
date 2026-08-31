/**
 * Copying one day's entry onto other days of the same month.
 *
 * A month of attendance is mostly the same day repeated, so the useful gesture
 * is "these days were like this one". This module owns the two questions that
 * asks — which dates are selected, and what a target day becomes — and answers
 * both without touching the network, the sheet, or React.
 *
 * The weekend rule is deliberate and asymmetric: a drag across a week is a
 * working-week gesture and skips Saturday and Sunday, while clicking a single
 * weekend day is an explicit statement that somebody worked it. See
 * `datesInRange` and `toggleDate`.
 *
 * Pure, like the rest of `attendance/` minus `service.ts`.
 */

import { fromIsoDate, toIsoDate } from "./iso-date";
import type { AttendanceDay } from "./model";

const SUNDAY = 0;
const SATURDAY = 6;
const MS_PER_DAY = 86_400_000;

function isWeekend(date: Date): boolean {
  const weekday = date.getDay();
  return weekday === SUNDAY || weekday === SATURDAY;
}

/**
 * Every weekday from one end of a drag to the other, inclusive, in calendar
 * order however the drag was made. An unparseable end yields nothing rather
 * than a guess.
 */
export function datesInRange(from: string, to: string): string[] {
  const first = fromIsoDate(from);
  const last = fromIsoDate(to);
  if (first === null || last === null) return [];

  const [start, end] = first.getTime() <= last.getTime() ? [first, last] : [last, first];
  const dates: string[] = [];

  for (
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    cursor.getTime() <= end.getTime();
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  ) {
    if (!isWeekend(cursor)) dates.push(toIsoDate(cursor));
  }

  return dates;
}

/**
 * Adds or removes one date, keeping the selection in calendar order. A weekend
 * is accepted here: this is the single-click path, where the person named the
 * day themselves.
 */
export function toggleDate(selected: readonly string[], date: string): string[] {
  if (selected.includes(date)) {
    return selected.filter((candidate) => candidate !== date);
  }

  return [...selected, date].sort();
}

/**
 * Whether the sheet holds anything for this day. The same reading the calendar
 * uses to mark entered days, so "already has an entry" means one thing in this
 * app: anything recorded, not just a clock time.
 */
export function hasEntry(day: AttendanceDay): boolean {
  return (
    day.statusCode !== null ||
    day.clockIn !== null ||
    day.clockOut !== null ||
    day.breakHours !== 0 ||
    day.notes.trim() !== "" ||
    Object.values(day.slots).some((slot) => slot.trim() !== "")
  );
}

/**
 * The target day as it would be after the copy: the source's entry under the
 * target's own date.
 *
 * `workHours` stays the target's own, because column H holds the `=F-G-E`
 * formula and is never written by a save — carrying a number across would
 * describe a value the sheet is going to recompute anyway.
 */
export function copyDayOnto(source: AttendanceDay, target: AttendanceDay): AttendanceDay {
  return {
    ...source,
    date: target.date,
    workHours: target.workHours,
    slots: { ...source.slots },
  };
}
