"use client";

import { useState } from "react";
import { DayMultiCalendar } from "@/components/day-multi-calendar";
import { copyDayOnto, hasEntry } from "@/lib/attendance/bulk-apply";
import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { toPatches } from "./attendance-columns";
import type { AttendanceApiClient } from "./attendance-api";
import { messageOf } from "./attendance-api";
import { isWeekend } from "./attendance-labels";

/**
 * Copying the open day onto other days of the month.
 *
 * A month of attendance is mostly the same day repeated, so this exists to stop
 * that being typed thirty times. The days are chosen on a calendar — click one,
 * or drag across a run — and the entry is written to each of them.
 *
 * Two rules are worth stating because they are what makes this safe to use:
 *
 * - days that already hold something are counted and named before anything is
 *   written, because applying is a replacement, not a merge;
 * - each day is saved through the ordinary per-day endpoint, one at a time, so
 *   every write is authorized, validated, and conflict-checked exactly as a
 *   hand-typed day is. Nothing here is a privileged bulk path.
 *
 * A failure stops at the day that failed and says which ones were written, so a
 * half-finished run is never reported as a whole one.
 */

const NOTHING_SELECTED = "Choose at least one day to apply this to.";
const APPLY_FAILED = "Could not write one of the days.";

export interface BulkApplyPanelProps {
  fileId: string;
  sheetId: string;
  view: AttendanceMonthView;
  /** The day being copied — the live draft, not the sheet's copy of it. */
  source: AttendanceDay;
  api: AttendanceApiClient;
  /** Reloads the month once days have been written. */
  onApplied: () => void;
  disabled?: boolean;
}

type ApplyState =
  | { status: "idle" }
  | { status: "applying"; done: number; total: number }
  | { status: "failed"; message: string; written: number };

export function BulkApplyPanel({
  fileId,
  sheetId,
  view,
  source,
  api,
  onApplied,
  disabled = false,
}: BulkApplyPanelProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [state, setState] = useState<ApplyState>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);

  const byDate = new Map(view.days.map((day) => [day.date, day]));
  const occupied = selected.filter((date) => {
    const day = byDate.get(date);
    return day !== undefined && hasEntry(day);
  });

  function reset(): void {
    setSelected([]);
    setState({ status: "idle" });
    setError(null);
  }

  async function apply(): Promise<void> {
    if (selected.length === 0) {
      setError(NOTHING_SELECTED);
      return;
    }

    setError(null);
    setState({ status: "applying", done: 0, total: selected.length });

    let written = 0;

    for (const date of selected) {
      const target = byDate.get(date);
      if (target === undefined) continue;

      const patches = toPatches(target, copyDayOnto(source, target), view.statuses);

      // An identical day needs no write, and Google should not be asked for one.
      if (patches.length === 0) {
        written += 1;
        setState({ status: "applying", done: written, total: selected.length });
        continue;
      }

      try {
        await api.save(fileId, sheetId, { date, patches });
        written += 1;
        setState({ status: "applying", done: written, total: selected.length });
      } catch (failure) {
        setState({ status: "failed", message: messageOf(failure, APPLY_FAILED), written });
        onApplied();
        return;
      }
    }

    reset();
    setOpen(false);
    onApplied();
  }

  if (!open) {
    return (
      <div className="bulk-apply">
        <button
          type="button"
          className="action"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Apply this day to other days
        </button>
      </div>
    );
  }

  const applying = state.status === "applying";

  return (
    <section className="bulk-apply bulk-apply-open" aria-labelledby="bulk-apply-heading">
      <h3 id="bulk-apply-heading">Apply this day to other days</h3>
      <p className="page-lede">
        Click a day, or drag across several. Dragging follows the working week and skips
        weekends; click a weekend to include it.
      </p>

      <DayMultiCalendar
        month={view.month}
        sourceDate={source.date}
        selected={selected}
        disabled={applying}
        days={view.days.map((day) => ({
          date: day.date,
          hasEntry: hasEntry(day),
          isWeekend: isWeekend(day.date),
        }))}
        onChange={(dates) => {
          setSelected(dates);
          setError(null);
        }}
      />

      <p className="bulk-apply-count" role="status">
        {selected.length === 0
          ? "No days chosen."
          : `${selected.length} ${selected.length === 1 ? "day" : "days"} chosen.`}
      </p>

      {occupied.length === 0 ? null : (
        <p role="alert" className="bulk-apply-warning">
          {`Replacing what is already recorded on ${occupied.length} of them: ${occupied.join(", ")}.`}
        </p>
      )}

      {error === null ? null : (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {state.status === "failed" ? (
        <p role="alert" className="field-error">
          {`${state.message} ${state.written} of ${selected.length} days were written.`}
        </p>
      ) : null}

      <div className="bulk-apply-actions">
        <button
          type="button"
          className="action action-primary"
          disabled={disabled || applying}
          onClick={() => void apply()}
        >
          {applying
            ? `Applying ${state.done} of ${state.total}…`
            : `Apply to ${selected.length} ${selected.length === 1 ? "day" : "days"}`}
        </button>
        <button
          type="button"
          className="action"
          disabled={applying}
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
