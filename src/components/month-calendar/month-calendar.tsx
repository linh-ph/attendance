"use client";

import type { KeyboardEvent } from "react";
import { buildMonthGrid } from "@/lib/attendance/calendar-grid";
import { dayRecordState } from "@/lib/attendance/day-state";
import type { AttendanceDay } from "@/lib/attendance/model";
import { formatMonthLabel } from "@/components/month-label";

/**
 * The month grid.
 *
 * The grid is built from `month` and from nothing else, so **the calendar is
 * always drawn**: an account with no timesheet, a month nobody has created, and
 * a failed check all still show an ordinary month. `days` is an *overlay* on
 * that grid. Building the cells from `days` instead — as this did — meant an
 * empty array rendered an empty panel, which read as a broken page rather than
 * as a month with nothing recorded in it yet.
 *
 * Consequences worth keeping:
 *
 * - Weeks are complete, and the first and last rows carry real dates from the
 *   neighbouring months rather than blanks, which is what makes the rows read
 *   as a calendar.
 * - A date the sheet has a row for is a button and opens the day preview. A
 *   date without one is inert: there is nothing to preview, and a control that
 *   does nothing is worse than no control.
 * - Keyboard movement walks the dates that *have* data, so arrow keys never
 *   land on an inert cell.
 */

export interface MonthCalendarProps {
  month: string;
  /** The overlay. Empty, partial, and absent are all ordinary. */
  days: readonly AttendanceDay[];
  selectedDate: string | null;
  todayDate: string | null;
  localDates: ReadonlySet<string>;
  attentionDates: ReadonlySet<string>;
  onSelect: (date: string, trigger: HTMLButtonElement) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FULL_DATE = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function readableDate(date: string): string {
  return FULL_DATE.format(new Date(`${date}T00:00:00.000Z`));
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Whether `date` is still to come.
 *
 * `todayDate` is the spreadsheet's own calendar day and is `null` when the file
 * reports no usable timezone. With no today to compare against, nothing is
 * treated as future — a month that has clearly passed still shows its gaps
 * rather than hiding them behind a missing property.
 */
function isAfter(date: string, todayDate: string | null): boolean {
  return todayDate !== null && date > todayDate;
}

function durationLabel(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours)) return null;
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}

export function MonthCalendar({
  month,
  days,
  selectedDate,
  todayDate,
  localDates,
  attentionDates,
  onSelect,
}: MonthCalendarProps) {
  const label = formatMonthLabel(month) ?? month;
  const weeks = buildMonthGrid(month);
  const overlay = new Map(days.map((day) => [day.date, day]));

  /**
   * Arrow keys move between the dates that carry data, in sheet order. Walking
   * the raw grid instead would step onto inert cells and onto the neighbouring
   * months, neither of which can be opened.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const offset =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? 7
            : event.key === "ArrowUp"
              ? -7
              : 0;

    if (offset !== 0) {
      event.preventDefault();
      const target = index + offset;
      if (target < 0 || target >= days.length) return;

      const cell = event.currentTarget
        .closest(".month-calendar")
        ?.querySelector<HTMLButtonElement>(`[data-date="${days[target].date}"]`);
      cell?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(days[index].date, event.currentTarget);
    }
  }

  return (
    <div className="month-calendar-shell">
      <div
        className="month-calendar"
        role="grid"
        aria-label={`${label} attendance calendar`}
        aria-readonly="true"
      >
        {WEEKDAYS.map((weekday) => (
          <div className="month-calendar-weekday" role="columnheader" key={weekday}>
            {weekday}
          </div>
        ))}

        {weeks.flatMap((week) =>
          week.cells.map((cell) => {
            const day = overlay.get(cell.date);
            const weekend = isWeekend(cell.date);
            const today = todayDate === cell.date;

            // No row in the sheet: an ordinary calendar date, not a fault, and
            // nothing to open.
            if (day === undefined) {
              const states = [
                cell.inMonth ? null : `Outside ${label}`,
                "No timesheet data",
                weekend ? "Non-working day" : null,
                today ? "Today" : null,
              ].filter(Boolean);

              return (
                <span
                  key={cell.date}
                  role="gridcell"
                  className={[
                    "month-calendar-day",
                    "month-calendar-day-no-data",
                    cell.inMonth ? "" : "is-outside",
                    weekend ? "is-non-working" : "",
                    today ? "is-today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={`${readableDate(cell.date)} — ${states.join(" — ")}`}
                  aria-current={today ? "date" : undefined}
                >
                  <span className="month-calendar-day-number">{Number(cell.date.slice(-2))}</span>
                </span>
              );
            }

            const index = days.indexOf(day);
            const recordState = dayRecordState(day);
            const selected = selectedDate === day.date;
            const local = localDates.has(day.date);
            const attention = attentionDates.has(day.date);
            /*
             * A working day that has passed with nothing recorded is the one
             * thing a person opens this calendar to find, so it is the one
             * thing painted red. A weekend is not missing anything, and neither
             * is a day that has not happened yet — colouring those would turn
             * the rest of the month red on the first of it.
             */
            const missing =
              recordState === "not-recorded" && !weekend && !isAfter(day.date, todayDate);
            const states = [
              recordState === "recorded" ? "Recorded" : "Not recorded",
              missing ? "Missing" : null,
              weekend ? "Non-working day" : null,
              local ? "Local changes" : null,
              attention ? "Needs attention" : null,
              selected ? "Selected" : null,
              today ? "Today" : null,
            ].filter(Boolean);

            return (
              <button
                key={day.date}
                type="button"
                role="gridcell"
                data-date={day.date}
                className={[
                  "month-calendar-day",
                  `month-calendar-day-${recordState}`,
                  cell.inMonth ? "" : "is-outside",
                  missing ? "is-missing" : "",
                  weekend ? "is-non-working" : "",
                  selected ? "is-selected" : "",
                  today ? "is-today" : "",
                  local ? "has-local-changes" : "",
                  attention ? "needs-attention" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`${readableDate(day.date)} — ${states.join(" — ")}`}
                aria-selected={selected}
                aria-current={today ? "date" : undefined}
                onClick={(event) => onSelect(day.date, event.currentTarget)}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                <span className="month-calendar-day-number">{Number(day.date.slice(-2))}</span>
                <span className="month-calendar-day-state">
                  {recordState === "recorded" ? "Recorded" : "Not recorded"}
                </span>
                {/*
                  Column H is `=F-G-E`, so a day whose clock columns hold only
                  the template's 08:00–17:00 still computes 8h. Printing that
                  next to `Not recorded` reads as a contradiction, so the
                  duration is shown only where something was actually recorded.
                */}
                {recordState === "recorded" && durationLabel(day.workHours) ? (
                  <span className="month-calendar-day-duration">{durationLabel(day.workHours)}</span>
                ) : null}
                <span className="month-calendar-markers" aria-hidden="true">
                  {local ? <span className="month-calendar-marker-local">L</span> : null}
                  {attention ? <span className="month-calendar-marker-attention">!</span> : null}
                </span>
              </button>
            );
          }),
        )}
      </div>

      <ul className="month-calendar-legend" aria-label="Calendar legend">
        <li data-legend="recorded">Recorded</li>
        <li data-legend="missing">Missing — a working day with nothing recorded</li>
        <li data-legend="not-recorded">Not recorded</li>
        <li data-legend="no-data">No timesheet data</li>
        <li data-legend="non-working">Non-working day</li>
        <li data-legend="local">Local changes</li>
        <li data-legend="attention">Needs attention</li>
      </ul>
    </div>
  );
}
