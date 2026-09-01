/**
 * The month's calendar grid, built from the calendar and from nothing else.
 *
 * This exists so the month view is **never** data-dependent. A timesheet that
 * has not been created, a month Google has nothing for, a sheet whose rows stop
 * halfway — none of them may turn the calendar into a blank panel. The grid is
 * a property of the month, the same way it is in any calendar application; the
 * attendance data is an overlay drawn on top of it.
 *
 * Weeks are complete, so every row has seven cells and the columns line up
 * under their weekday. The days that pad the first and last rows are real dates
 * from the neighbouring months, flagged `inMonth: false`, rather than blanks —
 * that is what makes a month grid read as a continuous calendar instead of a
 * table with holes in it.
 *
 * Every `Date` here is built and read in local fields through `iso-date`, never
 * parsed from a string, so the day a person sees is the day the sheet stores.
 *
 * Pure: no I/O, no React, no Google types.
 */

import { fromIsoDate, toIsoDate } from "./iso-date";

const ISO_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const DAYS_IN_WEEK = 7;

export interface MonthGridCell {
  /** `YYYY-MM-DD`. Always a real date, including in the padding. */
  date: string;
  /** `false` for the neighbouring-month dates that complete the first and last rows. */
  inMonth: boolean;
  /** `0` = Sunday. */
  weekday: number;
}

export interface MonthGridWeek {
  /** Stable across renders: the ISO date of the row's first cell. */
  key: string;
  cells: MonthGridCell[];
}

export interface MonthGridOptions {
  /** The weekday the row starts on, `0` = Sunday. Defaults to Sunday. */
  weekStartsOn?: number;
}

interface MonthParts {
  year: number;
  /** 0-based, as `Date` uses. */
  monthIndex: number;
}

function parseMonth(month: string): MonthParts | null {
  const match = ISO_MONTH.exec(month.trim());
  if (match === null) return null;

  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

function cellAt(date: Date, monthIndex: number): MonthGridCell {
  return {
    date: toIsoDate(date),
    inMonth: date.getMonth() === monthIndex,
    weekday: date.getDay(),
  };
}

/**
 * The weeks covering `month`, each complete, in calendar order.
 *
 * Returns `[]` only when `month` is not a `YYYY-MM` value — an empty grid is
 * reserved for "this is not a month", never for "there is no data".
 */
export function buildMonthGrid(month: string, options: MonthGridOptions = {}): MonthGridWeek[] {
  const parts = parseMonth(month);
  if (parts === null) return [];

  const weekStartsOn = ((options.weekStartsOn ?? 0) % DAYS_IN_WEEK + DAYS_IN_WEEK) % DAYS_IN_WEEK;

  const first = new Date(parts.year, parts.monthIndex, 1);
  // `new Date(y, m + 1, 0)` is the last day of month `m`, including February in
  // a leap year, without a table of month lengths.
  const last = new Date(parts.year, parts.monthIndex + 1, 0);

  const leading = (first.getDay() - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const trailing = (weekStartsOn + DAYS_IN_WEEK - 1 - last.getDay() + DAYS_IN_WEEK) % DAYS_IN_WEEK;

  const start = new Date(parts.year, parts.monthIndex, 1 - leading);
  const total = leading + last.getDate() + trailing;

  const weeks: MonthGridWeek[] = [];
  for (let offset = 0; offset < total; offset += DAYS_IN_WEEK) {
    const cells: MonthGridCell[] = [];

    for (let index = 0; index < DAYS_IN_WEEK; index += 1) {
      cells.push(
        cellAt(
          new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset + index),
          parts.monthIndex,
        ),
      );
    }

    weeks.push({ key: cells[0].date, cells });
  }

  return weeks;
}

/** The weekday order a header must use for `weekStartsOn`. `0` = Sunday. */
export function weekdayOrder(weekStartsOn = 0): number[] {
  const start = ((weekStartsOn % DAYS_IN_WEEK) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  return Array.from({ length: DAYS_IN_WEEK }, (_, index) => (start + index) % DAYS_IN_WEEK);
}

/** `YYYY-MM` shifted by whole months, or `null` when `month` is not one. */
export function shiftMonth(month: string, delta: number): string | null {
  const parts = parseMonth(month);
  if (parts === null) return null;

  const shifted = new Date(parts.year, parts.monthIndex + delta, 1);

  return `${String(shifted.getFullYear()).padStart(4, "0")}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

/** The `YYYY-MM` a `YYYY-MM-DD` belongs to, or `null`. */
export function monthOfDate(date: string): string | null {
  const parsed = fromIsoDate(date);
  if (parsed === null) return null;

  return `${String(parsed.getFullYear()).padStart(4, "0")}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}
