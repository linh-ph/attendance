"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";
import type { AttendanceDay } from "@/lib/attendance/model";
import { dayRecordState } from "@/lib/attendance/day-state";
import { decimalToTime } from "@/lib/attendance/time";
import type { SyncState } from "@/components/sync-status";
import { SyncStatus } from "@/components/sync-status";

export interface DayQuickPreviewProps {
  day: AttendanceDay;
  statusLabel: string | null;
  syncState: SyncState;
  lastCheckedLabel: string | null;
  detailHref: string;
  returnFocusElement: HTMLButtonElement | null;
  onClose: () => void;
}

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

function timeLabel(value: number | null): string {
  if (value === null) return "Not set";
  return decimalToTime(value) ?? String(value);
}

function hourLabel(value: number | null): string {
  if (value === null) return "Not available";
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)} hours`;
}

function workSummary(day: AttendanceDay): string {
  const entries = Object.entries(day.slots).filter(([, value]) => value.trim() !== "");
  if (entries.length === 0) return "No work blocks recorded";

  return entries
    .slice(0, 3)
    .map(([slot, value]) => `${slot} ${value.trim()}`)
    .join(" · ");
}

export function DayQuickPreview({
  day,
  statusLabel,
  syncState,
  lastCheckedLabel,
  detailHref,
  returnFocusElement,
  onClose,
}: DayQuickPreviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const title = readableDate(day.date);
  const recorded = dayRecordState(day) === "recorded";

  const close = useCallback(() => {
    onClose();
    returnFocusElement?.focus();
  }, [onClose, returnFocusElement]);

  useEffect(() => {
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }

    function onPointerDown(event: PointerEvent): void {
      const panel = panelRef.current;
      if (panel && !panel.contains(event.target as Node)) close();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close]);

  return (
    <div className="day-preview-layer">
      <div
        ref={panelRef}
        className="day-preview"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="day-preview-header">
          <div>
            <p className="eyebrow">Day preview</p>
            <h2>{title}</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-ghost day-preview-close"
            aria-label="Close day preview"
            onClick={close}
          >
            ×
          </button>
        </header>

        <div className="day-preview-state-row">
          <span className={`state-pill ${recorded ? "state-pill-synced" : "state-pill-pending"}`}>
            {recorded ? "Recorded" : "Not recorded"}
          </span>
          <SyncStatus
            state={syncState}
            announce={false}
            lastCheckedLabel={lastCheckedLabel ?? undefined}
          />
        </div>

        <dl className="day-preview-facts">
          <div><dt>Status</dt><dd>{statusLabel ?? "Not set"}</dd></div>
          <div><dt>Clock in</dt><dd>{timeLabel(day.clockIn)}</dd></div>
          <div><dt>Clock out</dt><dd>{timeLabel(day.clockOut)}</dd></div>
          <div><dt>Break</dt><dd>{hourLabel(day.breakHours)}</dd></div>
          <div><dt>Work hours</dt><dd>{hourLabel(day.workHours)}</dd></div>
        </dl>

        <section className="day-preview-copy" aria-labelledby="preview-notes">
          <h3 id="preview-notes">Notes</h3>
          <p>{day.notes.trim() || "No notes recorded"}</p>
        </section>

        <section className="day-preview-copy" aria-labelledby="preview-work">
          <h3 id="preview-work">Work blocks</h3>
          <p>{workSummary(day)}</p>
        </section>

        <div className="day-preview-actions">
          <button type="button" className="btn-secondary" onClick={close}>Close</button>
          <Link className="action action-primary" href={detailHref}>
            Open full detail
          </Link>
        </div>
      </div>
    </div>
  );
}
