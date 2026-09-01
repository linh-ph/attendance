"use client";

import type { KeyboardEvent } from "react";
import { dayRecordState } from "@/lib/attendance/day-state";
import type { AttendanceDay } from "@/lib/attendance/model";
import { formatMonthLabel } from "@/components/month-label";

export interface MonthCalendarProps {
  month: string;
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
  const [year, monthNumber] = month.split("-").map(Number);
  const leadingCells = Number.isInteger(year) && Number.isInteger(monthNumber)
    ? new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay()
    : 0;

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
      const cells = event.currentTarget
        .closest('[role="grid"]')
        ?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]');
      cells?.[index + offset]?.focus();
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

        {Array.from({ length: leadingCells }, (_, index) => (
          <span className="month-calendar-blank" aria-hidden="true" key={`blank-${index}`} />
        ))}

        {days.map((day, index) => {
          const recordState = dayRecordState(day);
          const weekend = isWeekend(day.date);
          const selected = selectedDate === day.date;
          const today = todayDate === day.date;
          const local = localDates.has(day.date);
          const attention = attentionDates.has(day.date);
          const states = [
            recordState === "recorded" ? "Recorded" : "Not recorded",
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
              className={[
                "month-calendar-day",
                `month-calendar-day-${recordState}`,
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
              {durationLabel(day.workHours) ? (
                <span className="month-calendar-day-duration">{durationLabel(day.workHours)}</span>
              ) : null}
              <span className="month-calendar-markers" aria-hidden="true">
                {local ? <span className="month-calendar-marker-local">L</span> : null}
                {attention ? <span className="month-calendar-marker-attention">!</span> : null}
              </span>
            </button>
          );
        })}
      </div>

      <ul className="month-calendar-legend" aria-label="Calendar legend">
        <li data-legend="recorded">Recorded</li>
        <li data-legend="not-recorded">Not recorded</li>
        <li data-legend="non-working">Non-working day</li>
        <li data-legend="local">Local changes</li>
        <li data-legend="attention">Needs attention</li>
      </ul>
    </div>
  );
}
