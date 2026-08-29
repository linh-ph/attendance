"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import { fromIsoDate, isoMonthStart, toIsoDate } from "@/lib/attendance/iso-date";

/**
 * Picking which day to record, as a month calendar rather than a long select.
 *
 * The month is fixed — a timesheet covers exactly one — so navigation is hidden
 * and only that month's days can be chosen. Days the sheet already has an entry
 * for are marked, which is the thing a person actually scans a timesheet for:
 * what is still missing.
 *
 * Dates cross this boundary as `YYYY-MM-DD` strings and are converted with
 * `iso-date`, never `new Date(string)`, so the day shown is the day stored.
 */

export interface DayCalendarOption {
  date: string;
  /** Drawn as filled, so gaps in the month are visible at a glance. */
  hasEntry: boolean;
  isWeekend: boolean;
}

export interface DayCalendarProps {
  /** `YYYY-MM`, the month this timesheet covers. */
  month: string;
  selected: string;
  days: readonly DayCalendarOption[];
  onSelect: (date: string) => void;
  disabled?: boolean;
}

export function DayCalendar({ month, selected, days, onSelect, disabled }: DayCalendarProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  // A popover that cannot be dismissed is a trap; Escape and an outside click
  // are the two ways people expect to leave one.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    function onPointerDown(event: PointerEvent): void {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const monthStart = isoMonthStart(month) ?? isoMonthStart(selected);
  const selectedDate = fromIsoDate(selected);

  const entered = days
    .filter((day) => day.hasEntry)
    .map((day) => fromIsoDate(day.date))
    .filter((date): date is Date => date !== null);

  const weekend = days
    .filter((day) => day.isWeekend)
    .map((day) => fromIsoDate(day.date))
    .filter((date): date is Date => date !== null);

  const selectable = new Set(days.map((day) => day.date));

  return (
    <div className="day-calendar" ref={containerRef}>
      <button
        type="button"
        className="day-calendar-trigger"
        // The two spans would otherwise run together into one unreadable
        // string; screen readers get the purpose and the current value.
        aria-label={`Choose day, currently ${selected}`}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="day-calendar-trigger-label">Day</span>
        <span className="day-calendar-trigger-value">{selected}</span>
      </button>

      {open ? (
        <div className="day-calendar-panel" id={panelId}>
          <DayPicker
            mode="single"
            required
            month={monthStart ?? undefined}
            startMonth={monthStart ?? undefined}
            endMonth={monthStart ?? undefined}
            hideNavigation
            showOutsideDays={false}
            selected={selectedDate ?? undefined}
            disabled={(date) => !selectable.has(toIsoDate(date))}
            modifiers={{ entered, weekend }}
            modifiersClassNames={{
              entered: "day-calendar-entered",
              weekend: "day-calendar-weekend",
            }}
            onSelect={(date) => {
              if (!date) return;
              onSelect(toIsoDate(date));
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
