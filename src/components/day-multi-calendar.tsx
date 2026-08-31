"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { DayPicker } from "react-day-picker";
import { datesInRange, toggleDate } from "@/lib/attendance/bulk-apply";
import { fromIsoDate, isoMonthStart, toIsoDate } from "@/lib/attendance/iso-date";

/**
 * Picking several days of one month, by click or by drag.
 *
 * Two gestures, and the difference between them is the point. A click toggles
 * exactly the day named, weekend included, because clicking a Saturday is
 * somebody saying they worked it. A drag is a working-week gesture and takes
 * the weekdays between its ends, skipping the weekend it crosses — both rules
 * live in `bulk-apply`, not here.
 *
 * The drag is built by hand, because `react-day-picker` has range and multiple
 * modes but no dragging. It exposes `onDayMouseEnter` but no mouse-down, so the
 * anchor comes from a `pointerdown` on the grid, read off the `data-day` each
 * cell already carries. A pointer released anywhere ends the drag: the listener
 * is on the window, so letting go outside the calendar cannot leave it stuck.
 */

export interface DayMultiCalendarOption {
  date: string;
  hasEntry: boolean;
  isWeekend: boolean;
}

export interface DayMultiCalendarProps {
  /** `YYYY-MM`, the month this timesheet covers. */
  month: string;
  /** The day being copied from; it is never selectable as a target. */
  sourceDate: string;
  selected: readonly string[];
  days: readonly DayMultiCalendarOption[];
  onChange: (dates: string[]) => void;
  disabled?: boolean;
}

export function DayMultiCalendar({
  month,
  sourceDate,
  selected,
  days,
  onChange,
  disabled = false,
}: DayMultiCalendarProps) {
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const dragMoved = useRef(false);

  // A drag that ends outside the grid must still end. Without this the next
  // hover would keep extending a selection nobody is dragging any more.
  useEffect(() => {
    if (dragFrom === null) return;

    function endDrag(): void {
      setDragFrom(null);
    }

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragFrom]);

  const monthStart = isoMonthStart(month) ?? isoMonthStart(sourceDate);
  const selectable = new Set(days.map((option) => option.date));

  const chosen = selected
    .map((date) => fromIsoDate(date))
    .filter((date): date is Date => date !== null);

  const entered = days
    .filter((option) => option.hasEntry)
    .map((option) => fromIsoDate(option.date))
    .filter((date): date is Date => date !== null);

  const weekend = days
    .filter((option) => option.isWeekend)
    .map((option) => fromIsoDate(option.date))
    .filter((date): date is Date => date !== null);

  const source = fromIsoDate(sourceDate);

  function isTargetable(date: string): boolean {
    return selectable.has(date) && date !== sourceDate;
  }

  /** Adds a dragged run to what is already chosen; a drag never unselects. */
  function extendTo(date: string): void {
    if (dragFrom === null) return;

    const run = datesInRange(dragFrom, date).filter(isTargetable);
    if (run.length === 0) return;

    dragMoved.current = true;
    onChange([...new Set([...selected, ...run])].sort());
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>): void {
    const cell = (event.target as HTMLElement).closest("[data-day]");
    const date = cell?.getAttribute("data-day");

    dragMoved.current = false;
    setDragFrom(date !== null && date !== undefined && isTargetable(date) ? date : null);
  }

  return (
    <div className="day-multi-calendar" onPointerDown={beginDrag}>
      {/*
        * No `mode`: the selection is this component's own state, driven by two
        * gestures the library does not have. Asking it to own a `multiple`
        * selection as well left the two disagreeing — it rendered nothing as
        * selected — so the chosen days are drawn as a modifier instead.
        */}
      <DayPicker
        month={monthStart ?? undefined}
        startMonth={monthStart ?? undefined}
        endMonth={monthStart ?? undefined}
        hideNavigation
        showOutsideDays={false}
        disabled={(date) => disabled || !isTargetable(toIsoDate(date))}
        modifiers={{
          chosen,
          entered,
          weekend,
          ...(source ? { source: [source] } : {}),
        }}
        modifiersClassNames={{
          chosen: "day-calendar-chosen",
          entered: "day-calendar-entered",
          weekend: "day-calendar-weekend",
          source: "day-calendar-source",
        }}
        onDayClick={(date) => {
          // A drag ends on a day too, and its `click` must not undo the run it
          // just selected.
          if (dragMoved.current) {
            dragMoved.current = false;
            return;
          }

          const iso = toIsoDate(date);
          if (isTargetable(iso)) onChange(toggleDate(selected, iso));
        }}
        onDayMouseEnter={(date) => extendTo(toIsoDate(date))}
      />
    </div>
  );
}
