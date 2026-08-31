/**
 * The one sync vocabulary — spec §5.4.
 *
 * Eight states, eight labels, and nothing else. A screen never phrases its own
 * status: it names a state from this table and the words come from here, so the
 * calendar, the day editor, the timesheet list, and the wizards cannot drift
 * into three different ways of saying "not saved yet".
 *
 * Each state answers the three questions every state in this design must
 * answer: **what happened** (`label` + `detail`), **whether the data is safe**
 * (`detail`), and **what to do next** (`action`).
 *
 * The pill class comes from F1's published primitives. Colour is never the only
 * carrier — the pill draws a shape from a pseudo-element and the markup always
 * supplies the word.
 *
 * Pure module: no React, no I/O, no browser API. It is imported by server and
 * client code alike.
 */

export const SYNC_STATE_ORDER = [
  "synced",
  "saved-locally",
  "syncing",
  "offline",
  "needs-attention",
  "remote-changes-detected",
  "local-storage-unavailable",
  "saved-remote-cache-unavailable",
] as const;

export type SyncState = (typeof SYNC_STATE_ORDER)[number];

/**
 * Why the day `Needs attention`. Spec §5.4 lists four causes for that one
 * state, and F1's contract sharpens two of them — a provider or authentication
 * failure — to the red `failed` pill. Every other state ignores the cause.
 */
export type SyncCause = "validation" | "conflict" | "authentication" | "provider";

export type SyncTone = "synced" | "pending" | "busy" | "attention" | "failed";

export interface SyncStateDescriptor {
  readonly state: SyncState;
  /** The spec's word, verbatim. Never reworded by a screen. */
  readonly label: string;
  /** What happened, and whether the data is safe. One sentence. */
  readonly detail: string;
  /** What to do next. One sentence, or "None." when there is nothing to do. */
  readonly action: string;
  readonly tone: SyncTone;
  /** The F1 primitive class that paints it. */
  readonly pillClass: string;
}

const TONE_PILL_CLASS: Record<SyncTone, string> = {
  synced: "state-pill-synced",
  pending: "state-pill-pending",
  busy: "state-pill-busy",
  attention: "state-pill-attention",
  failed: "state-pill-failed",
};

interface SyncStateEntry {
  readonly label: string;
  readonly detail: string;
  readonly action: string;
  readonly tone: SyncTone;
}

const SYNC_STATES: Record<SyncState, SyncStateEntry> = {
  synced: {
    label: "Synced",
    detail: "this month matches Google Sheets",
    action: "Nothing to do",
    tone: "synced",
  },
  "saved-locally": {
    label: "Saved locally",
    detail: "your changes are saved in this browser but not yet in Google Sheets",
    action: "Save & sync when you are ready",
    tone: "pending",
  },
  syncing: {
    label: "Syncing",
    detail: "your changes are on their way to Google Sheets",
    action: "Wait — Save is disabled until this finishes",
    tone: "busy",
  },
  offline: {
    label: "Offline",
    detail: "Google Sheets could not be reached and your local data is intact",
    action: "Keep working, or Retry",
    tone: "attention",
  },
  "needs-attention": {
    label: "Needs attention",
    detail: "something has to be resolved before this day can sync",
    action: "Follow the recovery step shown with this message",
    tone: "attention",
  },
  "remote-changes-detected": {
    label: "Remote changes detected",
    detail: "Google Sheets moved on after this copy was loaded and your local edits are safe",
    action: "Reload to discard yours, or Save — the last write wins",
    tone: "attention",
  },
  "local-storage-unavailable": {
    /*
     * Spec §5.3 is explicit that this must not claim the draft is durable, so
     * the detail says where the edit actually is: in this page only.
     */
    label: "Local storage unavailable",
    detail: "this edit is held in the page only and was not written to your browser storage",
    action: "keep this page open or save to Google Sheets",
    tone: "pending",
  },
  "saved-remote-cache-unavailable": {
    label: "Saved to Google Sheets · local cache unavailable",
    detail: "Google Sheets has your change, but this browser's copy could not be updated",
    action: "Do not save to Google Sheets again — retry the local cache, or it re-reads next open",
    tone: "pending",
  },
};

/** Resolves the tone, sharpening `Needs attention` when the cause is known. */
export function syncTone(state: SyncState, cause?: SyncCause): SyncTone {
  if (state !== "needs-attention") return SYNC_STATES[state].tone;
  return cause === "provider" || cause === "authentication" ? "failed" : "attention";
}

export function describeSyncState(state: SyncState, cause?: SyncCause): SyncStateDescriptor {
  const entry = SYNC_STATES[state];
  const tone = syncTone(state, cause);

  return {
    state,
    label: entry.label,
    detail: entry.detail,
    action: entry.action,
    tone,
    pillClass: TONE_PILL_CLASS[tone],
  };
}

/**
 * The full sentence read into the live region.
 *
 * `Synced` has nothing to do, so it announces its meaning rather than an
 * invented instruction; every other state announces what to do next. For
 * `Local storage unavailable` this reproduces spec §5.3's sentence exactly.
 */
export function syncAnnouncement(state: SyncState, cause?: SyncCause): string {
  const descriptor = describeSyncState(state, cause);
  const tail = state === "synced" ? descriptor.detail : descriptor.action;
  return `${descriptor.label} — ${tail}.`;
}
