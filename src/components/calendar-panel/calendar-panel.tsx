"use client";

import { useEffect, useId, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { MonthLabel, formatMonthLabel } from "@/components/month-label";
import { MonthInput } from "@/components/month-input";
import { StateNotice, SyncStatus } from "@/components/sync-status";
import { todayInZone } from "@/lib/attendance/zone";
import {
  resolveCalendarCache,
  type CalendarCache,
  type CalendarCacheContext,
} from "@/lib/cache/calendar-cache";
import type { CalendarSnapshot } from "@/lib/cache/calendar-state";
import type { CacheFailureReason } from "@/lib/cache/results";
import {
  currentMonth,
  syncCalendar,
  type SyncReport,
  type SyncTransport,
} from "@/lib/sync/calendar-sync";
import { createSyncTransport } from "@/lib/sync/sync-transport";
import { MonthGrid, MonthGridLegend } from "./month-grid";

/**
 * The calendar's first-load orchestration.
 *
 * Three things happen on open, in this order, and the order is the point:
 *
 * 1. **The browser's own copy is drawn first.** The stored pointer says which
 *    month this account was last on, and its snapshot paints the grid on the
 *    first frame — no blank wait for a network round trip.
 * 2. **Discovery runs in the background.** The authorized file list is fetched
 *    while the cached month is already on screen.
 * 3. **The current month is loaded from Google Sheets** and replaces the cached
 *    copy. Nothing cached is ever treated as authoritative: the server re-reads
 *    the sheet and re-authorizes every request.
 *
 * When no authorized file covers the month, the calendar does not guess and
 * does not go blank — it says which month it looked for and offers the two
 * things a person can actually do: pick another month, or create the file and
 * press `Load files` once it exists.
 *
 * Everything the panel needs is injected, so every path above is provable
 * without a browser or a network.
 */

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

interface PanelState {
  /** What can be drawn right now — cached at first, then the server's. */
  snapshot: CalendarSnapshot | null;
  /** A sync is in flight. Starts true: the effect runs on mount. */
  syncing: boolean;
  report: SyncReport | null;
  /** A refusal from browser storage, disclosed rather than hidden. */
  cacheFailure: CacheFailureReason | null;
  /** The month asked for; `null` means "whichever one is current". */
  requestedMonth: string | null;
  /**
   * An explicit file and tab, set when the person picked one from a list of
   * candidates. `syncCalendar` still matches both against the authorized
   * listing before addressing anything.
   */
  requestedFileId: string | null;
  requestedSheetId: string | null;
  /** Bumped to re-run the load. */
  attempt: number;
}

type PanelAction =
  | { type: "cache-hit"; snapshot: CalendarSnapshot }
  | { type: "cache-failed"; reason: CacheFailureReason }
  | { type: "synced"; report: SyncReport }
  | { type: "load-month"; month: string }
  | { type: "load-file"; fileId: string; sheetId: string }
  | { type: "reload" };

function reducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "cache-hit":
      /*
       * The cached month fills an empty screen and nothing else. Keying this on
       * `snapshot` rather than on `report` matters: a successful sync always
       * sets `snapshot`, so a cached copy still cannot overwrite fresher data —
       * but a sync that found no file for the current month leaves `snapshot`
       * null, and there the cached month is the best thing to show. Keying it
       * on `report` blanked the calendar whenever the network won that race.
       */
      return state.snapshot === null ? { ...state, snapshot: action.snapshot } : state;

    case "cache-failed":
      return state.cacheFailure === null ? { ...state, cacheFailure: action.reason } : state;

    case "synced":
      return {
        ...state,
        syncing: false,
        report: action.report,
        cacheFailure: action.report.cacheFailure ?? state.cacheFailure,
        // A failed check leaves the cached month on screen and usable.
        snapshot: action.report.snapshot ?? state.snapshot,
      };

    case "load-month":
      return {
        ...state,
        syncing: true,
        report: null,
        requestedMonth: action.month,
        // A new month is a new resolution: a file chosen for the old one says
        // nothing about which file covers this one.
        requestedFileId: null,
        requestedSheetId: null,
        attempt: state.attempt + 1,
      };

    case "load-file":
      return {
        ...state,
        syncing: true,
        report: null,
        requestedFileId: action.fileId,
        requestedSheetId: action.sheetId,
        attempt: state.attempt + 1,
      };

    case "reload":
      return { ...state, syncing: true, report: null, attempt: state.attempt + 1 };
  }
}

/* -------------------------------------------------------------------------- */
/* Cached read                                                                 */
/* -------------------------------------------------------------------------- */

/** The snapshot the stored pointer names, or `null` when there is none. */
async function readCachedMonth(
  cache: CalendarCache,
  email: string,
): Promise<{ snapshot: CalendarSnapshot | null; failure: CacheFailureReason | null }> {
  const pointer = await cache.readPointer(email);
  if (!pointer.ok) return { snapshot: null, failure: pointer.reason };
  if (pointer.value === null) return { snapshot: null, failure: null };

  const context: CalendarCacheContext = {
    email,
    fileId: pointer.value.fileId,
    sheetId: pointer.value.sheetId,
    month: pointer.value.month,
  };

  const snapshot = await cache.readSnapshot(context);
  if (!snapshot.ok) return { snapshot: null, failure: snapshot.reason };

  return { snapshot: snapshot.value, failure: null };
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

export interface CalendarPanelProps {
  /** Normalized signed-in email from the server session. */
  email: string;
  /** Injected in tests; the browser gets the real ones. */
  cache?: CalendarCache;
  transport?: SyncTransport;
  now?: () => Date;
}

function attendanceHref(fileId: string, sheetId: string | null): string {
  return sheetId === null
    ? `/files/${encodeURIComponent(fileId)}/attendance`
    : `/files/${encodeURIComponent(fileId)}/attendance/${encodeURIComponent(sheetId)}`;
}

export function CalendarPanel({
  email,
  cache: injectedCache,
  transport: injectedTransport,
  now: injectedNow,
}: CalendarPanelProps) {
  const [cache] = useState<CalendarCache>(() => injectedCache ?? resolveCalendarCache());
  const [transport] = useState<SyncTransport>(() => injectedTransport ?? createSyncTransport());
  const now = useMemo(() => injectedNow ?? (() => new Date()), [injectedNow]);

  const [state, dispatch] = useReducer(reducer, {
    snapshot: null,
    syncing: true,
    report: null,
    cacheFailure: null,
    requestedMonth: null,
    requestedFileId: null,
    requestedSheetId: null,
    attempt: 0,
  });

  const [monthDraft, setMonthDraft] = useState(() => currentMonth(now()));
  const monthFieldId = useId();

  const { snapshot, syncing, report, cacheFailure, requestedMonth, attempt } = state;
  const { requestedFileId, requestedSheetId } = state;

  /**
   * Draws the cached month, then loads the real one. State is set from promise
   * continuations with a cancellation guard, so a superseded load can never
   * overwrite a newer one.
   */
  useEffect(() => {
    let cancelled = false;

    void readCachedMonth(cache, email)
      .then(({ snapshot: cached, failure }) => {
        if (cancelled) return;
        if (cached) dispatch({ type: "cache-hit", snapshot: cached });
        if (failure) dispatch({ type: "cache-failed", reason: failure });
      })
      .catch(() => undefined);

    void syncCalendar(
      { transport, cache, now },
      { email, month: requestedMonth, fileId: requestedFileId, sheetId: requestedSheetId },
    )
      .then((result) => {
        if (!cancelled) dispatch({ type: "synced", report: result });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [cache, transport, now, email, requestedMonth, requestedFileId, requestedSheetId, attempt]);

  const wantedMonth = requestedMonth ?? report?.month ?? currentMonth(now());
  const today = snapshot ? todayInZone(snapshot.spreadsheetTimeZone, now()) : null;
  const lastChecked = report?.checkedAt ?? snapshot?.checkedAt ?? null;

  return (
    <section className="surface-panel calendar-panel" aria-labelledby="calendar-panel-title">
      <div className="section-header">
        <h2 id="calendar-panel-title">Calendar</h2>
        {syncing ? (
          <SyncStatus state="syncing" announce={false} />
        ) : report?.syncState ? (
          <SyncStatus
            state={report.syncState}
            cause={report.cause}
            announce={false}
            lastCheckedLabel={lastChecked ? `Last checked ${formatChecked(lastChecked)}` : undefined}
          />
        ) : null}
      </div>

      <CalendarBody
        snapshot={snapshot}
        today={today}
        syncing={syncing}
        report={report}
        wantedMonth={wantedMonth}
        onRetry={() => dispatch({ type: "reload" })}
        onChooseFile={(fileId, sheetId) => dispatch({ type: "load-file", fileId, sheetId })}
      />

      {cacheFailure === null ? null : (
        <StateNotice
          state="local-storage-unavailable"
          scope="section"
          detail="The month above was read from Google Sheets; only this browser's copy of it could not be written."
        />
      )}

      {report && report.unreadable.length > 0 ? (
        <StateNotice
          state="provider-failure"
          scope="section"
          detail={`${report.unreadable.length} attendance ${
            report.unreadable.length === 1 ? "file" : "files"
          } could not be read this time, so this list may be incomplete.`}
          onRetry={() => dispatch({ type: "reload" })}
        />
      ) : null}

      <form
        className="calendar-month-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (monthDraft !== "") dispatch({ type: "load-month", month: monthDraft });
        }}
      >
        <label htmlFor={monthFieldId}>Load another month</label>

        <MonthInput
          id={monthFieldId}
          value={monthDraft}
          invalid={false}
          disabled={syncing}
          onChange={setMonthDraft}
        />

        <button className="btn-secondary" type="submit" disabled={syncing || monthDraft === ""}>
          Load
        </button>

        {/* For the person who just created the file in another tab. */}
        <button
          className="btn-ghost"
          type="button"
          disabled={syncing}
          onClick={() => dispatch({ type: "reload" })}
        >
          Load files
        </button>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

interface CalendarBodyProps {
  snapshot: CalendarSnapshot | null;
  today: string | null;
  syncing: boolean;
  report: SyncReport | null;
  wantedMonth: string;
  onRetry: () => void;
  onChooseFile: (fileId: string, sheetId: string) => void;
}

function CalendarBody({
  snapshot,
  today,
  syncing,
  report,
  wantedMonth,
  onRetry,
  onChooseFile,
}: CalendarBodyProps) {
  if (snapshot !== null) {
    // Showing a month the person was last on while the month that was actually
    // checked has no file. Saying so is the difference between "here is where
    // you left off" and a calendar that looks stuck on the wrong month.
    const showingAnotherMonth =
      report !== null && report.context.kind === "none" && report.month !== snapshot.month;

    return (
      <>
        <MonthGrid snapshot={snapshot} today={today} />
        <MonthGridLegend hasToday={today !== null} />

        {showingAnotherMonth ? (
          <p className="page-lede">
            Showing <MonthLabel month={snapshot.month} />, where you left off. No timesheet covers{" "}
            <MonthLabel month={report.month} /> yet.
          </p>
        ) : null}

        {snapshot.spreadsheetTimeZone === null ? (
          <p className="page-lede">
            This spreadsheet does not report a timezone, so no date is marked as today.
          </p>
        ) : null}

        <p className="card-actions">
          <Link className="action action-primary" href={attendanceHref(snapshot.fileId, snapshot.sheetId)}>
            Open timesheet
          </Link>
        </p>
      </>
    );
  }

  if (syncing || report === null) {
    return <StateNotice state="first-load" scope="section" />;
  }

  if (report.syncState === "offline") {
    return <StateNotice state="offline-local-safe" scope="section" onRetry={onRetry} />;
  }

  if (report.cause === "authentication") {
    return <StateNotice state="authentication-expired" scope="section" />;
  }

  if (report.syncState === "needs-attention") {
    return <StateNotice state="provider-failure" scope="section" onRetry={onRetry} />;
  }

  if (report.context.kind === "choose-file") {
    return (
      <>
        <p className="page-lede">
          More than one timesheet covers <MonthLabel month={wantedMonth} />. Choose the one to open —
          the app will not pick for you.
        </p>
        <ul className="card-list">
          {report.context.candidates.map((candidate) => (
            <li key={candidate.id} className="card">
              <h3 className="card-title">{candidate.name}</h3>
              <p className="card-state">{candidate.ownerEmail}</p>
              <div className="card-actions">
                {/*
                  Showing it here is the lighter of the two choices: it draws
                  the month without leaving the dashboard. The pick is still
                  re-resolved against the authorized listing, and the route
                  re-authorizes when the person then opens the timesheet.
                */}
                {candidate.sheetId === null ? null : (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => onChooseFile(candidate.id, candidate.sheetId as string)}
                  >
                    Show in calendar
                  </button>
                )}
                <Link
                  className="action action-primary"
                  href={attendanceHref(candidate.id, candidate.sheetId)}
                >
                  Open
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (report.context.kind === "choose-tab") {
    const { timesheet } = report.context;

    return (
      <StateNotice
        state="no-timesheet"
        scope="section"
        title={timesheet.name}
        detail="This file has no configuration saying which tab is yours, so you choose it."
        action={{ label: "Choose your tab", href: attendanceHref(timesheet.id, null) }}
      />
    );
  }

  return (
    <StateNotice
      state="no-timesheet"
      scope="section"
      detail={`No timesheet covers ${formatMonthLabel(wantedMonth) ?? wantedMonth}. Load another month below, or create the file and press Load files.`}
      action={{ label: "Create a monthly file", href: "/files/new" }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const CHECKED_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatChecked(isoTime: string): string {
  const parsed = new Date(isoTime);
  if (Number.isNaN(parsed.getTime())) return isoTime;

  return `${CHECKED_FORMAT.format(parsed)} UTC`;
}
