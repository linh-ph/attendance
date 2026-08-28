/**
 * Every English string the editor puts on screen, and the date formatting
 * behind them.
 *
 * A domain value is never restated here: a validation issue is named by its
 * code, a conflict by the A1 column the range mapper produced, and a clock
 * value by `decimalToTime`, so the copy stays the only thing this module owns.
 */

import type { AttendanceConflict } from "@/lib/attendance/service";
import { decimalToTime } from "@/lib/attendance/time";
import type { ValidationIssue, ValidationIssueCode } from "@/lib/attendance/validation";
import {
  columnOf,
  isSummaryColumn,
  slotOfColumn,
  type SummaryColumn,
} from "./attendance-columns";

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export const LOAD_FAILED = "Could not load this timesheet.";
export const SAVE_FAILED = "Could not save this day to Google Sheets.";
export const SESSION_EXPIRED = "Your Google session expired. Sign in again to continue.";
export const NO_CHANGES = "There are no changes to save.";
export const UNSAVED_CHANGES = "You have unsaved changes on this day.";

const ISSUE_MESSAGES: Record<ValidationIssueCode, string> = {
  "invalid-boundary": "Use 30-minute time boundaries for clock and break values.",
  "clock-order": "Clock out must be later than clock in.",
  "break-negative": "Break hours cannot be negative.",
  "break-too-long": "Break hours cannot be longer than the clocked duration.",
  "work-hours-negative": "Work hours cannot be negative.",
  "unknown-status": "Choose a status from the list.",
  "empty-work-block": "Enter a work description and a valid time range.",
};

const CONFLICT_LABEL_BY_COLUMN: Record<SummaryColumn, string> = {
  D: "Status",
  E: "Clock in",
  F: "Clock out",
  G: "Break hours",
  I: "Notes",
};

function conflictFieldLabel(range: string): string {
  const column = columnOf(range);
  if (isSummaryColumn(column)) return CONFLICT_LABEL_BY_COLUMN[column];

  const slot = slotOfColumn(column);
  return slot === undefined ? "This day" : `${slot} work`;
}

/** Clock columns are disclosed on the 24-hour clock, like every other time. */
function conflictValueLabel(range: string, value: AttendanceConflict["current"]): string {
  if (value === null || value === "") return "empty";

  const column = columnOf(range);
  if ((column === "E" || column === "F") && typeof value === "number") {
    return decimalToTime(value) ?? String(value);
  }

  return String(value);
}

export function conflictMessage(conflict: AttendanceConflict): string {
  return `${conflictFieldLabel(conflict.range)} was changed to ${conflictValueLabel(
    conflict.range,
    conflict.current,
  )} by someone else; your value replaced it.`;
}

export function messagesFor(issues: readonly ValidationIssue[]): string[] {
  return [...new Set(issues.map((issue) => ISSUE_MESSAGES[issue.code]))];
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const OPTION_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function toUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) return month;

  return MONTH_FORMAT.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

export function formatDayTitle(isoDate: string): string {
  return DAY_FORMAT.format(toUtcDate(isoDate));
}

/** Column B is a weekday; the web renders it in English and flags weekends. */
export function isWeekend(isoDate: string): boolean {
  const weekday = toUtcDate(isoDate).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function dayOptionLabel(isoDate: string): string {
  const label = OPTION_FORMAT.format(toUtcDate(isoDate));
  return isWeekend(isoDate) ? `${label} · weekend` : label;
}
