"use client";

import { useEffect, useMemo, useReducer } from "react";
import { DaySummary, type DaySummaryChange } from "@/components/day-summary";
import { TimelineEditor } from "@/components/timeline-editor";
import { WorkBlockForm } from "@/components/work-block-form";
import type { AttendanceDay, TimeSlot } from "@/lib/attendance/model";
import { diffDay } from "@/lib/attendance/range-mapper";
import type {
  AttendanceConflict,
  AttendanceMonthView,
  AttendancePatch,
  SaveAttendanceResult,
} from "@/lib/attendance/service";
import {
  applyWorkBlock,
  isSlotWritable,
  setLunchBreak,
  TIME_SLOTS,
  type WorkBlock,
} from "@/lib/attendance/slots";
import { decimalToTime } from "@/lib/attendance/time";
import {
  calculateWorkHours,
  validateAttendanceDay,
  type ValidationIssue,
  type ValidationIssueCode,
} from "@/lib/attendance/validation";

/**
 * One month of one member sheet, edited a day at a time.
 *
 * The two editing methods — the 30-minute timeline and the work-block form —
 * are two views of a single draft held in one reducer. Neither component owns
 * state: they render the draft and report intent, so an edit made in either is
 * visible in the other on the next render, by construction rather than by
 * synchronization.
 *
 * All time, slot, lunch, and work-hour rules come from the attendance domain
 * (`slots`, `time`, `validation`, `range-mapper`). The editor decides *when* a
 * rule runs, never *what* it says: the work hours on screen are the sheet's
 * own `F-G-E`, and the dirty set is the same diff the save path uses.
 *
 * Nothing here talks to Google. The injected API client addresses the
 * attendance Route Handler, which re-authorizes every request.
 */

/* -------------------------------------------------------------------------- */
/* API client                                                                  */
/* -------------------------------------------------------------------------- */

export interface AttendanceSaveInput {
  /** `YYYY-MM-DD` inside the configured month. */
  date: string;
  /** Only the dirty cells, each carrying the baseline it was read with. */
  patches: AttendancePatch[];
}

export interface AttendanceApiClient {
  read(fileId: string, sheetId: string): Promise<AttendanceMonthView>;
  save(fileId: string, sheetId: string, input: AttendanceSaveInput): Promise<SaveAttendanceResult>;
}

export interface AttendanceApiError extends Error {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  code?: string;
  issues?: ValidationIssue[];
}

const LOAD_FAILED = "Could not load this timesheet.";
const SAVE_FAILED = "Could not save this day to Google Sheets.";
const SESSION_EXPIRED = "Your Google session expired. Sign in again to continue.";
const NO_CHANGES = "There are no changes to save.";
const UNSAVED_CHANGES = "You have unsaved changes on this day.";

function attendanceUrl(fileId: string, sheetId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/attendance/${encodeURIComponent(sheetId)}`;
}

async function requestJson<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    // The request never reached the server; the draft is untouched either way.
    const error = new Error(fallback) as AttendanceApiError;
    error.status = 0;
    throw error;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const envelope = (body ?? {}) as { error?: string; code?: string; issues?: ValidationIssue[] };
    const error = new Error(envelope.error ?? fallback) as AttendanceApiError;
    error.status = response.status;
    error.code = envelope.code;
    error.issues = envelope.issues;
    throw error;
  }

  return body as T;
}

export const attendanceApiClient: AttendanceApiClient = {
  read: (fileId, sheetId) =>
    requestJson<AttendanceMonthView>(attendanceUrl(fileId, sheetId), LOAD_FAILED),
  save: (fileId, sheetId, input) =>
    requestJson<SaveAttendanceResult>(attendanceUrl(fileId, sheetId), SAVE_FAILED, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};

/* -------------------------------------------------------------------------- */
/* Dirty set                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Field key for each addressable summary column, mirroring the range mapper.
 *
 * The dirty set is produced by `diffDay` — the same rule the server diffs with —
 * and then translated back from A1 columns to the wire's field keys. Column H
 * has no key here because it is a formula, and A/B/C are generated.
 */
const SUMMARY_FIELD_BY_COLUMN = {
  D: "status",
  E: "clockIn",
  F: "clockOut",
  G: "breakHours",
  I: "notes",
} as const;

type SummaryColumn = keyof typeof SUMMARY_FIELD_BY_COLUMN;

/** `diffDay` writes the first work slot to column J. */
const FIRST_SLOT_COLUMN_INDEX = 10;

/** Any row works: only the column of each dirty range is read back. */
const DIFF_ROW = 1;

function columnOf(range: string): string {
  return /^[A-Z]+/.exec(range)?.[0] ?? "";
}

function columnIndexOf(column: string): number {
  return [...column].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

function slotOfColumn(column: string): TimeSlot | undefined {
  return TIME_SLOTS[columnIndexOf(column) - FIRST_SLOT_COLUMN_INDEX];
}

function isSummaryColumn(column: string): column is SummaryColumn {
  return column in SUMMARY_FIELD_BY_COLUMN;
}

/**
 * The dirty cells as field-keyed patches, each with the baseline it was read
 * with so the server can disclose a last-writer conflict per cell.
 */
export function toPatches(
  baseline: AttendanceDay,
  draft: AttendanceDay,
  statuses: AttendanceMonthView["statuses"],
): AttendancePatch[] {
  return diffDay(baseline, draft, DIFF_ROW, statuses).flatMap<AttendancePatch>((patch) => {
    const column = columnOf(patch.range);

    if (isSummaryColumn(column)) {
      switch (SUMMARY_FIELD_BY_COLUMN[column]) {
        case "status":
          return [{ field: "status", baseline: baseline.statusCode, value: draft.statusCode }];
        case "clockIn":
          return [{ field: "clockIn", baseline: baseline.clockIn, value: draft.clockIn }];
        case "clockOut":
          return [{ field: "clockOut", baseline: baseline.clockOut, value: draft.clockOut }];
        case "breakHours":
          return [{ field: "breakHours", baseline: baseline.breakHours, value: draft.breakHours }];
        case "notes":
          return [{ field: "notes", baseline: baseline.notes, value: draft.notes }];
      }
    }

    const slot = slotOfColumn(column);
    return slot === undefined
      ? []
      : [{ field: "slot", slot, baseline: baseline.slots[slot], value: draft.slots[slot] }];
  });
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

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

function conflictMessage(conflict: AttendanceConflict): string {
  return `${conflictFieldLabel(conflict.range)} was changed to ${conflictValueLabel(
    conflict.range,
    conflict.current,
  )} by someone else; your value replaced it.`;
}

function messagesFor(issues: readonly ValidationIssue[]): string[] {
  return [...new Set(issues.map((issue) => ISSUE_MESSAGES[issue.code]))];
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

function issuesOf(error: unknown): ValidationIssue[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as ValidationIssue[]) : [];
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
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

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) return month;

  return MONTH_FORMAT.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/** Column B is a weekday; the web renders it in English and flags weekends. */
function isWeekend(isoDate: string): boolean {
  const weekday = toUtcDate(isoDate).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function dayOptionLabel(isoDate: string): string {
  const label = OPTION_FORMAT.format(toUtcDate(isoDate));
  return isWeekend(isoDate) ? `${label} · weekend` : label;
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; conflicts: AttendanceConflict[] }
  | { status: "blocked"; messages: string[] }
  | { status: "failed"; message: string; canRetry: boolean; needsReauth: boolean };

interface EditorState {
  view: AttendanceMonthView | null;
  loadError: string | null;
  /** Incremented by a reload so the loading effect runs again. */
  loadAttempt: number;
  selectedDate: string | null;
  /** The day exactly as the sheet was read; every patch baseline comes from it. */
  baseline: AttendanceDay | null;
  draft: AttendanceDay | null;
  /** A day the user asked for while the current one still has unsaved edits. */
  pendingDate: string | null;
  saveState: SaveState;
}

type EditorAction =
  | { type: "reload" }
  | { type: "loaded"; view: AttendanceMonthView; today: string }
  | { type: "load-failed" }
  | { type: "select-date"; date: string }
  | { type: "discard-changes" }
  | { type: "cancel-navigation" }
  | { type: "summary-change"; change: DaySummaryChange }
  | { type: "slot-change"; slot: TimeSlot; value: string }
  | { type: "work-block"; block: WorkBlock }
  | { type: "save-blocked"; messages: string[] }
  | { type: "save-started" }
  | { type: "save-succeeded"; result: SaveAttendanceResult }
  | { type: "save-failed"; message: string; canRetry: boolean; needsReauth: boolean };

const INITIAL_STATE: EditorState = {
  view: null,
  loadError: null,
  loadAttempt: 0,
  selectedDate: null,
  baseline: null,
  draft: null,
  pendingDate: null,
  saveState: { status: "idle" },
};

/** Column H follows every draft change, by the same rule as the sheet formula. */
function withWorkHours(day: AttendanceDay): AttendanceDay {
  return { ...day, workHours: calculateWorkHours(day) };
}

/**
 * Restores the reserved slots when the lunch break is cleared.
 *
 * Selecting lunch only empties the two slots *in the draft*; the sheet still
 * holds their text until an explicit Save. Clearing the checkbox before saving
 * must therefore put the baseline text back rather than silently keep a
 * deletion the user just undid. The reserved set is read from the domain rule,
 * never restated here.
 */
function releaseLunchBreak(draft: AttendanceDay, baseline: AttendanceDay): AttendanceDay {
  const reserved = TIME_SLOTS.filter((slot) => !isSlotWritable(draft, slot));
  const released = setLunchBreak(draft, false);
  const slots = { ...released.slots };

  for (const slot of reserved) {
    if (slots[slot] === "") slots[slot] = baseline.slots[slot];
  }

  return { ...released, slots };
}

function applySummaryChange(
  draft: AttendanceDay,
  baseline: AttendanceDay,
  change: DaySummaryChange,
): AttendanceDay {
  switch (change.field) {
    case "status":
      return { ...draft, statusCode: change.value };
    case "clockIn":
      return { ...draft, clockIn: change.value };
    case "clockOut":
      return { ...draft, clockOut: change.value };
    case "breakHours":
      return { ...draft, breakHours: change.value };
    case "notes":
      return { ...draft, notes: change.value };
    case "lunchBreak":
      return change.value ? setLunchBreak(draft, true) : releaseLunchBreak(draft, baseline);
  }
}

/** Any draft edit supersedes the previous save outcome. */
function withDraft(state: EditorState, draft: AttendanceDay): EditorState {
  return { ...state, draft: withWorkHours(draft), saveState: { status: "idle" } };
}

function openDay(state: EditorState, view: AttendanceMonthView, date: string): EditorState {
  const day = view.days.find((candidate) => candidate.date === date);
  if (day === undefined) return state;

  return {
    ...state,
    view,
    loadError: null,
    selectedDate: date,
    baseline: day,
    draft: withWorkHours(day),
    pendingDate: null,
    saveState: { status: "idle" },
  };
}

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "reload":
      return { ...INITIAL_STATE, loadAttempt: state.loadAttempt + 1 };

    case "loaded": {
      // Today wins when the configured month contains it; otherwise day one.
      const preferred = action.view.days.some((day) => day.date === action.today)
        ? action.today
        : (action.view.days[0]?.date ?? null);

      return preferred === null
        ? { ...state, view: action.view, loadError: null }
        : openDay(state, action.view, preferred);
    }

    case "load-failed":
      return { ...state, view: null, loadError: LOAD_FAILED };

    case "select-date": {
      if (state.view === null || action.date === state.selectedDate) return state;
      // Never abandon unsaved work silently.
      if (isDirty(state)) return { ...state, pendingDate: action.date };
      return openDay(state, state.view, action.date);
    }

    case "discard-changes":
      return state.view === null || state.pendingDate === null
        ? state
        : openDay(state, state.view, state.pendingDate);

    case "cancel-navigation":
      return { ...state, pendingDate: null };

    case "summary-change":
      return state.draft === null || state.baseline === null
        ? state
        : withDraft(state, applySummaryChange(state.draft, state.baseline, action.change));

    case "slot-change": {
      if (state.draft === null || !isSlotWritable(state.draft, action.slot)) return state;
      return withDraft(state, {
        ...state.draft,
        slots: { ...state.draft.slots, [action.slot]: action.value },
      });
    }

    case "work-block": {
      if (state.draft === null) return state;
      try {
        const expanded = applyWorkBlock(state.draft, action.block);
        return withDraft(state, { ...state.draft, slots: expanded.slots });
      } catch {
        // The form already refused every invalid block; nothing to change.
        return state;
      }
    }

    case "save-blocked":
      return { ...state, saveState: { status: "blocked", messages: action.messages } };

    case "save-started":
      return { ...state, saveState: { status: "saving" } };

    case "save-succeeded": {
      if (state.view === null || state.draft === null || state.selectedDate === null) return state;

      const saved = state.draft;
      const days = state.view.days.map((day) => (day.date === saved.date ? saved : day));

      // The saved draft becomes the new baseline: a disclosed conflict is
      // reported, never rolled back, because the write already happened.
      return {
        ...state,
        view: { ...state.view, days },
        baseline: saved,
        saveState: { status: "saved", conflicts: action.result.conflicts },
      };
    }

    case "save-failed":
      return {
        ...state,
        saveState: {
          status: "failed",
          message: action.message,
          canRetry: action.canRetry,
          needsReauth: action.needsReauth,
        },
      };
  }
}

function isDirty(state: EditorState): boolean {
  if (state.view === null || state.baseline === null || state.draft === null) return false;
  return toPatches(state.baseline, state.draft, state.view.statuses).length > 0;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

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
          {DAY_FORMAT.format(toUtcDate(selectedDate))}
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
