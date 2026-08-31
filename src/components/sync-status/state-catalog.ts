/**
 * The reusable state gallery — spec §8.2.
 *
 * Fourteen states, written once. Each answers the same three questions in the
 * same order, because a person hitting one of them needs all three and no more:
 *
 * - `title` — **what happened**;
 * - `dataSafety` — **whether their data is safe**;
 * - `guidance` — **what to do next**.
 *
 * `scope` carries the rule that stops a single bad file taking a page down with
 * it: a state that describes *one item* is `card`, so a dashboard listing ten
 * files renders nine of them and one card error. Only a state that genuinely
 * invalidates the page is `page`. A screen may raise a state's scope when it
 * really is the whole page — it may never reword the state.
 *
 * `recovery` names the shared recovery grammar the state deserves; the screen
 * decides which of those it can actually perform by wiring the handler.
 *
 * Pure module: no React, no I/O.
 */

export const SYSTEM_STATE_ORDER = [
  "first-load",
  "revalidating",
  "local-storage-unavailable",
  "no-timesheet",
  "no-managed-files",
  "no-members",
  "folder-unavailable",
  "offline-local-safe",
  "local-changes-pending",
  "remote-changes-detected",
  "authentication-expired",
  "provider-failure",
  "partial-setup",
  "invalid-workbook",
] as const;

export type SystemStateId = (typeof SYSTEM_STATE_ORDER)[number];

/** Where the state belongs, and therefore how big its recovery may be. */
export type StateScope = "page" | "section" | "card";

/** What kind of surface it is, which decides whether it announces itself. */
export type StateKind = "loading" | "empty" | "notice";

/** The shared recovery grammar. A screen renders only what it wires up. */
export type RecoveryAction = "retry" | "reauthenticate" | "resume" | "reload";

export const RECOVERY_LABELS: Record<RecoveryAction, string> = {
  retry: "Try again",
  reauthenticate: "Re-authenticate",
  resume: "Resume",
  reload: "Reload",
};

export interface SystemStateDescriptor {
  readonly id: SystemStateId;
  readonly kind: StateKind;
  readonly scope: StateScope;
  /** Uppercase micro-label naming the category, for `.eyebrow`. */
  readonly eyebrow: string;
  /** What happened. */
  readonly title: string;
  /** Whether the data is safe. */
  readonly dataSafety: string;
  /** What to do next. */
  readonly guidance: string;
  readonly recovery: readonly RecoveryAction[];
  /** The F1 primitive class that paints the state pill. */
  readonly pillClass: string;
}

const CATALOG: Record<SystemStateId, Omit<SystemStateDescriptor, "id">> = {
  "first-load": {
    kind: "loading",
    scope: "page",
    eyebrow: "Loading",
    title: "Preparing your calendar",
    dataSafety: "Nothing has changed yet.",
    guidance: "Reading the workbook and saving this month to your browser.",
    recovery: [],
    pillClass: "state-pill-busy",
  },
  revalidating: {
    kind: "loading",
    scope: "section",
    eyebrow: "Checking",
    title: "Showing your saved copy",
    dataSafety: "This is the copy saved in your browser, so it is complete.",
    guidance: "Google Sheets is being checked in the background — no action needed.",
    recovery: [],
    pillClass: "state-pill-busy",
  },
  "local-storage-unavailable": {
    kind: "notice",
    scope: "section",
    eyebrow: "Storage",
    title: "This browser could not save your draft",
    /*
     * Spec §5.3 forbids claiming the draft is durable. The wording says exactly
     * where the edit is instead of implying it was written anywhere.
     */
    dataSafety: "Your edit is held in this page only. It was not written to browser storage.",
    guidance: "Keep this page open, or save to Google Sheets now.",
    recovery: ["retry"],
    pillClass: "state-pill-pending",
  },
  "no-timesheet": {
    kind: "empty",
    scope: "section",
    eyebrow: "Empty",
    title: "No timesheet for this month",
    dataSafety: "Nothing is missing — no file has been shared with you for it yet.",
    guidance: "Choose a shared file, or ask your manager to add you.",
    recovery: [],
    pillClass: "state-pill-neutral",
  },
  "no-managed-files": {
    kind: "empty",
    scope: "section",
    eyebrow: "Empty",
    title: "No attendance files here yet",
    dataSafety: "Nothing has been lost — this folder simply has none.",
    guidance: "Create a file for the month, or import an existing workbook.",
    recovery: [],
    pillClass: "state-pill-neutral",
  },
  "no-members": {
    kind: "empty",
    scope: "section",
    eyebrow: "Empty",
    title: "No members yet",
    dataSafety: "The file is fine — nobody has been added to it.",
    guidance: "Add the people who record hours in this file.",
    recovery: [],
    pillClass: "state-pill-neutral",
  },
  "folder-unavailable": {
    kind: "notice",
    scope: "section",
    eyebrow: "Folder",
    title: "Choose another folder",
    dataSafety: "No file was changed. Only the remembered folder is unusable.",
    guidance: "The saved folder was moved, deleted, or is no longer writable. Select a folder.",
    recovery: ["retry"],
    pillClass: "state-pill-attention",
  },
  "offline-local-safe": {
    kind: "notice",
    scope: "section",
    eyebrow: "Offline",
    title: "Google Sheets could not be reached",
    dataSafety: "Your local data is safe and complete.",
    guidance: "Keep working. Sync when the connection returns, or try again now.",
    recovery: ["retry"],
    pillClass: "state-pill-attention",
  },
  "local-changes-pending": {
    kind: "notice",
    scope: "section",
    eyebrow: "Pending",
    title: "Changes saved in this browser",
    dataSafety: "Your edits are safe here, but Google Sheets does not have them yet.",
    guidance: "Save & sync to send them to Google Sheets.",
    recovery: [],
    pillClass: "state-pill-pending",
  },
  "remote-changes-detected": {
    kind: "notice",
    scope: "section",
    eyebrow: "Conflict",
    title: "Google Sheets changed",
    dataSafety: "Your local edits are safe. The sheet moved on after this copy was loaded.",
    guidance: "Reload to take the newer values, or save yours — the last write wins.",
    recovery: ["reload"],
    pillClass: "state-pill-attention",
  },
  "authentication-expired": {
    kind: "notice",
    scope: "page",
    eyebrow: "Session",
    title: "Your Google session expired",
    dataSafety: "Nothing was lost. Anything saved in this browser is still here.",
    guidance: "Sign in with your Google account again to continue.",
    recovery: ["reauthenticate"],
    pillClass: "state-pill-failed",
  },
  "provider-failure": {
    kind: "notice",
    scope: "page",
    eyebrow: "Google",
    title: "Google did not respond",
    dataSafety: "Your locally saved attendance is unchanged.",
    guidance: "Try again in a moment. If it keeps failing, sign in again.",
    recovery: ["retry", "reauthenticate"],
    pillClass: "state-pill-failed",
  },
  "partial-setup": {
    kind: "notice",
    scope: "card",
    eyebrow: "Unfinished",
    title: "Setup did not finish",
    dataSafety: "The steps that succeeded were kept. Nothing was deleted or rolled back.",
    guidance: "Resume to complete the remaining steps.",
    recovery: ["resume"],
    pillClass: "state-pill-pending",
  },
  "invalid-workbook": {
    kind: "notice",
    scope: "card",
    eyebrow: "Workbook",
    title: "This workbook cannot be used",
    dataSafety: "The file was not changed. Your other files are unaffected.",
    guidance: "Check the sheet layout and month, then upload the workbook again.",
    recovery: [],
    pillClass: "state-pill-failed",
  },
};

export function describeSystemState(id: SystemStateId): SystemStateDescriptor {
  return { id, ...CATALOG[id] };
}
