/**
 * The one place that decides what a calendar load actually does.
 *
 * A first open, a month change, and the Settings `Sync now` button are the same
 * three steps in the same order — discover the authorized files, decide which
 * one covers the wanted month, read that month and cache it — so they run
 * through one function rather than three that drift.
 *
 * Three properties this module is responsible for:
 *
 * 1. **It never guesses.** Two files covering one month, or a file with no tab
 *    mapping, resolve to an explicit choice for the person. The app opening
 *    "probably the right one" is how somebody records a month into a colleague's
 *    timesheet.
 * 2. **It never addresses a file discovery did not list.** An explicit file or
 *    tab is matched against the server-authorized listing before it is read —
 *    the same rule the pasted-link resolver follows. The listing is not
 *    authorization (the route re-authorizes), it is a refusal to construct a
 *    request nobody offered.
 * 3. **It never reports an outage as an empty state.** A failed discovery
 *    resolves to a named sync state with a cause, and the files that could not
 *    be read travel with the report.
 *
 * Dependency-injected and free of React, `fetch`, and Google types, so every
 * rule above is provable without a browser.
 */

import type { AttendanceMonthView } from "@/lib/attendance/service";
import type { AttendanceCache } from "@/lib/cache/attendance-cache";
import type { CalendarPointerStore } from "@/lib/cache/calendar-pointer";
import type { CacheFailureReason } from "@/lib/cache/results";
import type { Timesheet, UnreadableFile } from "@/lib/discovery/file-discovery";
import type { SyncCause, SyncState } from "@/components/sync-status/sync-state";

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a call to our own API failed, in the vocabulary the sync states use.
 *
 * `offline` is "the request never reached the server"; `provider` is "Google
 * answered badly", which includes the Sheets API being disabled for the project;
 * `authentication` is an expired session; `forbidden` is a refusal that is about
 * this file rather than about the system.
 */
export type SyncFailureKind = "offline" | "authentication" | "provider" | "forbidden";

export class SyncTransportError extends Error {
  readonly kind: SyncFailureKind;

  constructor(kind: SyncFailureKind, message: string) {
    super(message);
    this.name = "SyncTransportError";
    this.kind = kind;
  }
}

export interface DiscoveryResult {
  timesheets: Timesheet[];
  unreadable: UnreadableFile[];
}

export interface SyncTransport {
  /** `GET /api/dashboard` — the server-authorized listing. */
  discover(): Promise<DiscoveryResult>;
  /** `GET /api/files/[fileId]/attendance/[sheetId]` — re-authorized per call. */
  readMonth(fileId: string, sheetId: string): Promise<AttendanceMonthView>;
}

export interface SyncDependencies {
  transport: SyncTransport;
  /** The one month store. This module adds no second copy of the data. */
  cache: AttendanceCache;
  /** Records which month the calendar is on, so a cold open can find it. */
  pointer: CalendarPointerStore;
  now(): Date;
}

/* -------------------------------------------------------------------------- */
/* Month and context                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The month to *try* first, as `YYYY-MM`, from the device calendar.
 *
 * This is deliberately not `Today`. `Today` is a spreadsheet property and comes
 * from `todayInZone` with the file's own IANA zone — no file is selected yet at
 * this point, so there is no zone to ask. Being one day out at a month boundary
 * costs a person one click on the month chooser; inventing a zone for `Today`
 * would highlight the wrong row in a timesheet, which is not recoverable by
 * clicking.
 */
export function currentMonth(now: Date): string {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export type CalendarContextResolution =
  /** Exactly one authorized file, with a tab this person is mapped to. */
  | { kind: "ready"; timesheet: Timesheet; sheetId: string }
  /** One file, but nothing says which tab is this person's. They pick. */
  | { kind: "choose-tab"; timesheet: Timesheet }
  /** Several files cover the month. The app never picks for them. */
  | { kind: "choose-file"; candidates: Timesheet[] }
  /** No authorized file covers the month at all. */
  | { kind: "none"; month: string };

export function resolveCalendarContext(
  timesheets: readonly Timesheet[],
  month: string,
): CalendarContextResolution {
  const candidates = timesheets.filter((sheet) => sheet.month === month);

  if (candidates.length === 0) return { kind: "none", month };
  if (candidates.length > 1) return { kind: "choose-file", candidates };

  const [only] = candidates;
  if (only.sheetId === null) return { kind: "choose-tab", timesheet: only };

  return { kind: "ready", timesheet: only, sheetId: only.sheetId };
}

/**
 * Resolves an explicit file/tab choice against the authorized listing.
 *
 * Both halves are checked: the file must be one discovery returned, and the tab
 * must be one that file lists. A `gid` copied from a URL therefore cannot reach
 * a tab the listing never offered.
 *
 * A choice that cannot be honoured degrades to **asking**, never to opening
 * something else. Silently loading a different file when the requested one is
 * not listed would answer a question nobody asked, and the file it landed on
 * could be another person's.
 */
function resolveExplicitContext(
  timesheets: readonly Timesheet[],
  fileId: string,
  sheetId: string,
  month: string,
): CalendarContextResolution {
  const chosen = timesheets.find((sheet) => sheet.id === fileId);

  if (chosen === undefined) {
    const fallback = resolveCalendarContext(timesheets, month);
    return fallback.kind === "ready"
      ? { kind: "choose-file", candidates: [fallback.timesheet] }
      : fallback;
  }

  const known = chosen.sheetId === sheetId || chosen.tabs.some((tab) => tab.sheetId === sheetId);
  if (!known) return { kind: "choose-tab", timesheet: chosen };

  return { kind: "ready", timesheet: chosen, sheetId };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

export interface SyncRequest {
  /** Normalized signed-in email. Scopes the cache; grants nothing. */
  email: string;
  /** An explicit month, or `null`/absent for the current one. */
  month?: string | null;
  /** An explicit file and tab, which skips candidate resolution. */
  fileId?: string | null;
  sheetId?: string | null;
}

export interface SyncReport {
  timesheets: Timesheet[];
  /** Files Drive listed but whose contents could not be read this request. */
  unreadable: UnreadableFile[];
  month: string;
  context: CalendarContextResolution;
  /** The month as Google answered it, or `null` when none was read. */
  view: AttendanceMonthView | null;
  /** `null` when nothing was synced because nothing is selected yet. */
  syncState: SyncState | null;
  cause?: SyncCause;
  /** Set when the sheet read succeeded but the browser refused to store it. */
  cacheFailure: CacheFailureReason | null;
  /** ISO instant of a successful Sheets read; `null` when there was none. */
  checkedAt: string | null;
  /** Technical detail for the debug disclosure. Never rendered as prose. */
  detail: string | null;
}

const FAILURE_STATE: Record<SyncFailureKind, { state: SyncState; cause?: SyncCause }> = {
  offline: { state: "offline" },
  authentication: { state: "needs-attention", cause: "authentication" },
  provider: { state: "needs-attention", cause: "provider" },
  forbidden: { state: "needs-attention", cause: "validation" },
};

function toFailure(error: unknown): { state: SyncState; cause?: SyncCause; detail: string } {
  if (error instanceof SyncTransportError) {
    return { ...FAILURE_STATE[error.kind], detail: error.message };
  }

  // An unrecognized throw is still a failure; it is never quietly a success.
  return {
    state: "needs-attention",
    cause: "provider",
    detail: error instanceof Error ? error.message : "The request failed.",
  };
}

/* -------------------------------------------------------------------------- */
/* Sync                                                                        */
/* -------------------------------------------------------------------------- */

export async function syncCalendar(
  dependencies: SyncDependencies,
  request: SyncRequest,
): Promise<SyncReport> {
  const { transport, cache, pointer, now } = dependencies;
  const month = request.month?.trim() || currentMonth(now());

  let discovered: DiscoveryResult;
  try {
    discovered = await transport.discover();
  } catch (error) {
    const failure = toFailure(error);

    return {
      timesheets: [],
      unreadable: [],
      month,
      context: { kind: "none", month },
      view: null,
      syncState: failure.state,
      ...(failure.cause ? { cause: failure.cause } : {}),
      cacheFailure: null,
      checkedAt: null,
      detail: failure.detail,
    };
  }

  const { timesheets, unreadable } = discovered;

  const context =
    request.fileId && request.sheetId
      ? resolveExplicitContext(timesheets, request.fileId, request.sheetId, month)
      : resolveCalendarContext(timesheets, month);

  if (context.kind !== "ready") {
    return {
      timesheets,
      unreadable,
      month,
      context,
      view: null,
      syncState: null,
      cacheFailure: null,
      checkedAt: null,
      detail: null,
    };
  }

  let view: AttendanceMonthView;
  try {
    view = await transport.readMonth(context.timesheet.id, context.sheetId);
  } catch (error) {
    const failure = toFailure(error);

    return {
      timesheets,
      unreadable,
      month,
      context,
      view: null,
      syncState: failure.state,
      ...(failure.cause ? { cause: failure.cause } : {}),
      cacheFailure: null,
      checkedAt: null,
      detail: failure.detail,
    };
  }

  const checkedAt = now().toISOString();

  // The configuration owns the month, so what came back is authoritative over
  // what was asked for.
  const cacheContext = {
    email: request.email,
    fileId: view.fileId,
    sheetId: String(view.sheetId),
    month: view.month,
  };

  const written = await cache.writeMonth(cacheContext, { view, checkedAt });

  // The pointer is the address of what was just stored, so it is only moved
  // once the month itself is in place — never onto a month that failed to
  // cache, which would send the next cold open to an empty key.
  const pointed = written.ok
    ? await pointer.write(cacheContext)
    : ({ ok: false, reason: written.reason, message: written.message } as const);

  const failure = !written.ok ? written : !pointed.ok ? pointed : null;

  return {
    timesheets,
    unreadable,
    month: view.month,
    context,
    view,
    // The sheet read succeeded either way. Only the local copy can still fail,
    // and saying `Synced` then would claim a cache that does not exist.
    syncState: failure === null ? "synced" : "local-storage-unavailable",
    cacheFailure: failure?.reason ?? null,
    checkedAt,
    detail: failure?.message ?? null,
  };
}
