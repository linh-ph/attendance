"use client";

import { useEffect, useMemo, useReducer } from "react";
import { DaySummary } from "@/components/day-summary";
import { TimelineEditor } from "@/components/timeline-editor";
import { WorkBlockForm } from "@/components/work-block-form";
import { validateAttendanceDay } from "@/lib/attendance/validation";
import {
  attendanceApiClient,
  issuesOf,
  messageOf,
  statusOf,
  type AttendanceApiClient,
} from "./attendance-api";
import { toPatches } from "./attendance-columns";
import { INITIAL_STATE, reducer } from "./attendance-draft";
import {
  conflictMessage,
  dayOptionLabel,
  formatDayTitle,
  formatMonth,
  isWeekend,
  messagesFor,
  NO_CHANGES,
  SAVE_FAILED,
  SESSION_EXPIRED,
  UNSAVED_CHANGES,
} from "./attendance-labels";

export { attendanceApiClient } from "./attendance-api";
export type {
  AttendanceApiClient,
  AttendanceApiError,
  AttendanceSaveInput,
} from "./attendance-api";
export { toPatches } from "./attendance-columns";

/**
 * One month of one member sheet, edited a day at a time.
 *
 * The two editing methods — the 30-minute timeline and the work-block form —
 * are two views of a single draft held in one reducer (`attendance-draft.ts`).
 * Neither component owns state: they render the draft and report intent, so an
 * edit made in either is visible in the other on the next render, by
 * construction rather than by synchronization.
 *
 * All time, slot, lunch, and work-hour rules come from the attendance domain
 * (`slots`, `time`, `validation`, `range-mapper`). The editor decides *when* a
 * rule runs, never *what* it says: the work hours on screen are the sheet's
 * own `F-G-E`, and the dirty set is the same diff the save path uses.
 *
 * Nothing here talks to Google. The injected API client addresses the
 * attendance Route Handler, which re-authorizes every request.
 */

export interface AttendanceEditorProps {
  fileId: string;
  /** Numeric sheet ID from the route. */
  sheetId: string;
  /** Injected in tests; the browser uses the Route Handler client. */
  api?: AttendanceApiClient;
  /** Injected in tests; defaults to the current UTC calendar date. */
  today?: string;
}

export function AttendanceEditor({
  fileId,
  sheetId,
  api = attendanceApiClient,
  today = new Date().toISOString().slice(0, 10),
}: AttendanceEditorProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const { view, baseline, draft, selectedDate, saveState, pendingDate } = state;

  /**
   * Loads the configured month once per attempt. State is set from the promise
   * continuation, and a superseded response is discarded so a slow read for a
   * previous sheet can never overwrite a newer one.
   */
  useEffect(() => {
    let cancelled = false;

    api
      .read(fileId, sheetId)
      .then((loaded) => {
        if (!cancelled) dispatch({ type: "loaded", view: loaded, today });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "load-failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [api, fileId, sheetId, today, state.loadAttempt]);

  const patches = useMemo(
    () => (view === null || baseline === null || draft === null
      ? []
      : toPatches(baseline, draft, view.statuses)),
    [view, baseline, draft],
  );
  const dirty = patches.length > 0;

  /** Browser-level navigation gets the same protection as day navigation. */
  useEffect(() => {
    if (!dirty) return;

    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function handleSave(): void {
    if (view === null || draft === null || selectedDate === null) return;

    if (patches.length === 0) {
      dispatch({ type: "save-blocked", messages: [NO_CHANGES] });
      return;
    }

    // The same rules the server enforces, applied before the request so an
    // impossible day never leaves the browser.
    const issues = validateAttendanceDay(draft, view.statuses);
    if (issues.length > 0) {
      dispatch({ type: "save-blocked", messages: messagesFor(issues) });
      return;
    }

    dispatch({ type: "save-started" });

    api
      .save(view.fileId, sheetId, { date: selectedDate, patches })
      .then((result) => dispatch({ type: "save-succeeded", result }))
      .catch((error: unknown) => {
        const status = statusOf(error);

        if (status === 401) {
          dispatch({
            type: "save-failed",
            message: SESSION_EXPIRED,
            canRetry: false,
            needsReauth: true,
          });
          return;
        }

        const issues = issuesOf(error);
        if (issues.length > 0) {
          dispatch({ type: "save-blocked", messages: messagesFor(issues) });
          return;
        }

        dispatch({
          type: "save-failed",
          message: messageOf(error, SAVE_FAILED),
          canRetry: status === 0 || status >= 409,
          needsReauth: false,
        });
      });
  }

  if (state.loadError !== null) {
    return (
      <div className="attendance">
        <p role="alert" className="page-error">
          {state.loadError}
        </p>
        <button type="button" className="action" onClick={() => dispatch({ type: "reload" })}>
          Retry
        </button>
      </div>
    );
  }

  if (view === null || draft === null || selectedDate === null) {
    return (
      <div className="attendance">
        <p>Loading this timesheet…</p>
      </div>
    );
  }

  const dayIndex = view.days.findIndex((day) => day.date === selectedDate);
  const saving = saveState.status === "saving";

  return (
    <div className="attendance">
      <header className="attendance-header">
        <h2 className="attendance-month">{formatMonth(view.month)}</h2>
        <p className="attendance-sheet">{view.sheetTitle}</p>

        <nav className="day-navigation" aria-label="Day navigation">
          <button
            type="button"
            className="action"
            disabled={dayIndex <= 0}
            onClick={() =>
              dispatch({ type: "select-date", date: view.days[dayIndex - 1]?.date ?? selectedDate })
            }
          >
            Previous day
          </button>

          <div className="field">
            <label htmlFor="attendance-day">Day</label>
            <select
              id="attendance-day"
              className="field-control"
              value={selectedDate}
              onChange={(event) => dispatch({ type: "select-date", date: event.target.value })}
            >
              {view.days.map((day) => (
                <option key={day.date} value={day.date}>
                  {dayOptionLabel(day.date)}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="action"
            disabled={dayIndex < 0 || dayIndex >= view.days.length - 1}
            onClick={() =>
              dispatch({ type: "select-date", date: view.days[dayIndex + 1]?.date ?? selectedDate })
            }
          >
            Next day
          </button>
        </nav>

        <p className={isWeekend(selectedDate) ? "day-title day-title-weekend" : "day-title"}>
          {formatDayTitle(selectedDate)}
        </p>
        {isWeekend(selectedDate) ? <p className="day-weekend">Weekend</p> : null}
      </header>

      {pendingDate === null ? null : (
        <div className="navigation-warning">
          <p role="alert">{UNSAVED_CHANGES}</p>
          <div className="navigation-warning-actions">
            <button
              type="button"
              className="action"
              onClick={() => dispatch({ type: "discard-changes" })}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="action action-primary"
              onClick={() => dispatch({ type: "cancel-navigation" })}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}

      <section className="section" aria-labelledby="day-summary-heading">
        <h3 id="day-summary-heading">Day summary</h3>
        <DaySummary
          day={draft}
          statuses={view.statuses}
          disabled={saving}
          onChange={(change) => dispatch({ type: "summary-change", change })}
        />
      </section>

      <section className="section" aria-labelledby="work-block-heading">
        <h3 id="work-block-heading">Work block</h3>
        <WorkBlockForm
          day={draft}
          disabled={saving}
          onApply={(block) => dispatch({ type: "work-block", block })}
        />
      </section>

      <section className="section" aria-labelledby="timeline-heading">
        <h3 id="timeline-heading">Work report</h3>
        <TimelineEditor
          day={draft}
          disabled={saving}
          onSlotChange={(slot, value) => dispatch({ type: "slot-change", slot, value })}
        />
      </section>

      <div className="attendance-actions">
        <button
          type="button"
          className="action action-primary"
          disabled={saving}
          onClick={handleSave}
        >
          Save to Google Sheets
        </button>

        {dirty ? <p className="dirty-indicator">Unsaved changes</p> : null}

        <p role="status" className="save-status">
          {saving ? "Saving…" : null}
          {saveState.status === "saved" ? "Saved to Google Sheets." : null}
        </p>
      </div>

      {saveState.status === "blocked" ? (
        <ul role="alert" className="form-error">
          {saveState.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {saveState.status === "failed" ? (
        <div className="form-error">
          <p role="alert">{saveState.message}</p>
          <div className="form-error-actions">
            {saveState.canRetry ? (
              <button type="button" className="action" onClick={handleSave}>
                Retry
              </button>
            ) : null}
            {saveState.needsReauth ? (
              <a className="action" href="/login">
                Sign in again
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {saveState.status === "saved" && saveState.conflicts.length > 0 ? (
        <div className="conflict-disclosure">
          <p role="alert">Someone else edited this day while you were working on it.</p>
          <ul>
            {saveState.conflicts.map((conflict) => (
              <li key={conflict.range}>{conflictMessage(conflict)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
