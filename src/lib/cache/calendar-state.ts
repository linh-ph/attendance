/**
 * The calendar's quick-info record: which month it is on, and what each date
 * looks like.
 *
 * The acknowledged month cache (`attendance-cache.ts`) already stores the full
 * `AttendanceMonthView`, and that stays the record a day editor rehydrates
 * from. This is a deliberately smaller, second projection: everything the month
 * grid needs to paint a date, and nothing else. It exists so the calendar can
 * draw from storage on the first frame without rehydrating 30 days of 36 work
 * slots, and so "which month was I on" survives a reload as one small record
 * rather than being re-derived from whatever the network answers first.
 *
 * Two rules the projection may never break:
 *
 * - **No authorization result.** A snapshot carries no `role`, and the guard
 *   refuses a record that does, exactly as `records.ts` does. A cached role
 *   would let the calendar draw manager-only affordances from storage, which is
 *   the cache-first render rule's one prohibition.
 * - **No second definition of Recorded.** `record` comes from the domain's own
 *   `dayRecordState`, and `nonWorking` from `nonWorkingDaySource`. This module
 *   projects those answers; it does not re-decide them.
 *
 * Pure: no IndexedDB, no React, no Google types.
 */

import {
  dayRecordState,
  nonWorkingDaySource,
  type DayRecordState,
  type NonWorkingDaySource,
} from "@/lib/attendance/day-state";
import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { normalizeSpreadsheetTimeZone } from "@/lib/attendance/zone";
import { CACHE_SCHEMA_VERSION, normalizeAccount } from "./keys";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export interface CalendarDayState {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The domain's two-value vocabulary. There is deliberately no `complete`. */
  record: DayRecordState;
  /** Orthogonal to `record`: a Saturday can be recorded. `null` when working. */
  nonWorking: NonWorkingDaySource | null;
  /**
   * Column H as it was read. Derived by the sheet's own `=F-G-E`, never written
   * by this app, and never a carrier for `record` — a cell can hold a formula
   * result on a day nobody entered anything.
   */
  workHours: number | null;
  statusCode: string | null;
}

export interface CalendarSnapshot {
  schemaVersion: number;
  /** Normalized signed-in email. Scopes the record; grants nothing. */
  account: string;
  fileId: string;
  /** Numeric sheet ID as a string, matching the rest of the app. */
  sheetId: string;
  sheetTitle: string;
  /** `YYYY-MM` — the month the calendar is on. */
  month: string;
  /** A validated IANA id, or `null` meaning undeterminable. Never UTC. */
  spreadsheetTimeZone: string | null;
  days: CalendarDayState[];
  /** ISO instant of the last **successful** Sheets read this came from. */
  checkedAt: string;
}

/**
 * Where the calendar was last pointed, stored once per account.
 *
 * This is the record that answers "which month is the calendar loading" before
 * any snapshot is read, so a reload restores the same context instead of
 * re-running discovery to find out.
 */
export interface CalendarPointer {
  schemaVersion: number;
  account: string;
  fileId: string;
  sheetId: string;
  month: string;
  updatedAt: string;
}

export interface CalendarSummary {
  days: number;
  recorded: number;
  notRecorded: number;
  /** The number a person actually chases: working days still empty. */
  workingDaysNotRecorded: number;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuildCalendarSnapshotInput {
  email: string;
  view: AttendanceMonthView;
  /** ISO instant of the successful read. Supplied, never taken from a clock. */
  checkedAt: string;
  /** Dates the calendar context marks non-working. This module owns no list. */
  nonWorkingDates?: readonly string[];
}

function toDayState(day: AttendanceDay, nonWorkingDates?: readonly string[]): CalendarDayState {
  return {
    date: day.date,
    record: dayRecordState(day),
    nonWorking: nonWorkingDaySource(day.date, { nonWorkingDates }),
    workHours: day.workHours,
    statusCode: day.statusCode,
  };
}

/**
 * Projects one month view into the calendar's quick-info record.
 *
 * `view.role` is read by nothing here, so the snapshot cannot carry it even by
 * accident — the fields are listed, never spread.
 */
export function buildCalendarSnapshot(input: BuildCalendarSnapshotInput): CalendarSnapshot {
  const { email, view, checkedAt, nonWorkingDates } = input;

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    account: normalizeAccount(email),
    fileId: view.fileId,
    sheetId: String(view.sheetId),
    sheetTitle: view.sheetTitle,
    month: view.month,
    spreadsheetTimeZone: normalizeSpreadsheetTimeZone(view.spreadsheetTimeZone),
    days: view.days.map((day) => toDayState(day, nonWorkingDates)),
    checkedAt,
  };
}

export interface BuildCalendarPointerInput {
  email: string;
  fileId: string;
  sheetId: string;
  month: string;
  updatedAt: string;
}

export function buildCalendarPointer(input: BuildCalendarPointerInput): CalendarPointer {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    account: normalizeAccount(input.email),
    fileId: input.fileId,
    sheetId: input.sheetId,
    month: input.month,
    updatedAt: input.updatedAt,
  };
}

/** The pointer implied by a snapshot, so the two can never name different months. */
export function pointerForSnapshot(snapshot: CalendarSnapshot, updatedAt: string): CalendarPointer {
  return {
    schemaVersion: snapshot.schemaVersion,
    account: snapshot.account,
    fileId: snapshot.fileId,
    sheetId: snapshot.sheetId,
    month: snapshot.month,
    updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export function summarizeCalendar(snapshot: CalendarSnapshot): CalendarSummary {
  let recorded = 0;
  let workingDaysNotRecorded = 0;

  for (const day of snapshot.days) {
    if (day.record === "recorded") {
      recorded += 1;
      continue;
    }
    if (day.nonWorking === null) workingDaysNotRecorded += 1;
  }

  return {
    days: snapshot.days.length,
    recorded,
    notRecorded: snapshot.days.length - recorded,
    workingDaysNotRecorded,
  };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function hasScope(value: Record<string, unknown>): boolean {
  return (
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    isNonEmptyString(value.account) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.sheetId) &&
    isNonEmptyString(value.month)
  );
}

export function isCalendarSnapshot(value: unknown): value is CalendarSnapshot {
  if (!isRecord(value) || !hasScope(value)) return false;

  return (
    // A record carrying an authorization outcome is not one this build wrote,
    // so it reads as corrupt rather than handing a role back to a caller.
    value.role === undefined &&
    isNonEmptyString(value.checkedAt) &&
    isNonEmptyString(value.sheetTitle) &&
    Array.isArray(value.days) &&
    value.days.every((day) => isRecord(day) && isNonEmptyString(day.date))
  );
}

export function isCalendarPointer(value: unknown): value is CalendarPointer {
  if (!isRecord(value) || !hasScope(value)) return false;

  return value.role === undefined && isNonEmptyString(value.updatedAt);
}
