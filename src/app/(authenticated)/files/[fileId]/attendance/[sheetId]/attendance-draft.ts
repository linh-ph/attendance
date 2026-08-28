/**
 * The one draft the whole editor edits.
 *
 * The 30-minute timeline and the work-block form are two views of this single
 * reducer state: neither owns anything, so an edit made in either is visible in
 * the other on the next render, by construction rather than by synchronization.
 *
 * All time, slot, lunch, and work-hour rules come from the attendance domain
 * (`slots`, `time`, `validation`, `range-mapper`). The reducer decides *when* a
 * rule runs, never *what* it says: column H follows `calculateWorkHours`, and
 * the dirty set is the same diff the save path sends.
 */

import type { DaySummaryChange } from "@/components/day-summary";
import type { AttendanceDay, TimeSlot } from "@/lib/attendance/model";
import type {
  AttendanceConflict,
  AttendanceMonthView,
  SaveAttendanceResult,
} from "@/lib/attendance/service";
import {
  applyWorkBlock,
  isSlotWritable,
  setLunchBreak,
  TIME_SLOTS,
  type WorkBlock,
} from "@/lib/attendance/slots";
import { calculateWorkHours } from "@/lib/attendance/validation";
import { toPatches } from "./attendance-columns";
import { LOAD_FAILED } from "./attendance-labels";

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; conflicts: AttendanceConflict[] }
  | { status: "blocked"; messages: string[] }
  | { status: "failed"; message: string; canRetry: boolean; needsReauth: boolean };

export interface EditorState {
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

export type EditorAction =
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

export const INITIAL_STATE: EditorState = {
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

export function reducer(state: EditorState, action: EditorAction): EditorState {
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
