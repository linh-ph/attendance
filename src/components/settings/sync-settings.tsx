"use client";

import { useMemo, useState } from "react";
import { StateNotice, SyncStatus } from "@/components/sync-status";
import { formatMonthLabel } from "@/components/month-label";
import { resolveCalendarCache, type CalendarCache } from "@/lib/cache/calendar-cache";
import { summarizeCalendar } from "@/lib/cache/calendar-state";
import { syncCalendar, type SyncReport, type SyncTransport } from "@/lib/sync/calendar-sync";
import { createSyncTransport } from "@/lib/sync/sync-transport";

/**
 * `Sync now` — the manual pull from Google Sheets into this browser's copy.
 *
 * This is a **section on the account page**, not a new navigation destination:
 * spec §3.2 fixes the shell's destinations and forbids a `Settings` slot, and
 * the account page is where the things that belong to this browser and this
 * session already live.
 *
 * The calendar syncs itself on open, so this exists for the cases where that is
 * not enough: the person just created or was granted a file, a background check
 * failed and they want to retry deliberately, or they are about to lose network
 * and want this month stored locally first.
 *
 * It reports what actually happened, in the published vocabulary and with
 * numbers: which month, how many dates it now holds, and how many are still
 * empty. A sync that read the sheet but could not write the local copy says so
 * rather than claiming `Synced` — that distinction is the whole reason the
 * cache acknowledges its writes.
 */

export interface SyncSettingsProps {
  /** Normalized signed-in email from the server session. */
  email: string;
  /** Injected in tests; the browser gets the real ones. */
  cache?: CalendarCache;
  transport?: SyncTransport;
  now?: () => Date;
}

type Phase = { status: "idle" } | { status: "running" } | { status: "done"; report: SyncReport };

export function SyncSettings({
  email,
  cache: injectedCache,
  transport: injectedTransport,
  now: injectedNow,
}: SyncSettingsProps) {
  const [cache] = useState<CalendarCache>(() => injectedCache ?? resolveCalendarCache());
  const [transport] = useState<SyncTransport>(() => injectedTransport ?? createSyncTransport());
  const now = useMemo(() => injectedNow ?? (() => new Date()), [injectedNow]);

  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  async function runSync(): Promise<void> {
    setPhase({ status: "running" });

    // `syncCalendar` resolves with a failure report rather than throwing, so
    // there is no path where the button stays stuck on `Syncing`.
    const report = await syncCalendar({ transport, cache, now }, { email });

    setPhase({ status: "done", report });
  }

  const report = phase.status === "done" ? phase.report : null;
  const summary = report?.snapshot ? summarizeCalendar(report.snapshot) : null;

  return (
    <section className="surface-panel" aria-labelledby="sync-settings-title">
      <div className="section-header">
        <h2 id="sync-settings-title">Data and sync</h2>
        {phase.status === "running" ? (
          <SyncStatus state="syncing" announce={false} />
        ) : report?.syncState ? (
          <SyncStatus state={report.syncState} cause={report.cause} announce={false} />
        ) : null}
      </div>

      <p className="page-lede">
        Google Sheets is the only place your attendance is stored. This browser
        keeps a copy of the month you are looking at so the calendar opens
        without waiting, and syncing refreshes that copy from the sheet.
      </p>

      <div className="card-actions">
        <button
          className="btn-primary"
          type="button"
          disabled={phase.status === "running"}
          onClick={() => {
            void runSync();
          }}
        >
          {phase.status === "running" ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {report === null ? null : <SyncOutcome report={report} summary={summary} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Outcome                                                                     */
/* -------------------------------------------------------------------------- */

interface SyncOutcomeProps {
  report: SyncReport;
  summary: ReturnType<typeof summarizeCalendar> | null;
}

function SyncOutcome({ report, summary }: SyncOutcomeProps) {
  if (report.cause === "authentication") {
    return <StateNotice state="authentication-expired" scope="section" />;
  }

  if (report.syncState === "offline") {
    return <StateNotice state="offline-local-safe" scope="section" />;
  }

  if (report.syncState === "needs-attention") {
    return <StateNotice state="provider-failure" scope="section" />;
  }

  if (report.snapshot === null) {
    // Nothing was read because nothing is selected — an ordinary state, not a
    // failure, and it names the month so the answer is actionable.
    return (
      <StateNotice
        state="no-timesheet"
        scope="section"
        detail={`Nothing was synced: no timesheet covers ${
          formatMonthLabel(report.month) ?? report.month
        }. Open the calendar to pick another month.`}
        action={{ label: "Open the calendar", href: "/dashboard" }}
      />
    );
  }

  return (
    <>
      <dl className="card-facts">
        <div className="card-fact">
          <dt>Month synced</dt>
          <dd className="card-fact-numeric">
            {formatMonthLabel(report.snapshot.month) ?? report.snapshot.month}
          </dd>
        </div>
        <div className="card-fact">
          <dt>Timesheet</dt>
          <dd>{report.snapshot.sheetTitle}</dd>
        </div>
        <div className="card-fact">
          <dt>Dates stored</dt>
          <dd className="card-fact-numeric">{summary?.days ?? 0}</dd>
        </div>
        <div className="card-fact">
          <dt>Recorded</dt>
          <dd className="card-fact-numeric">
            {summary?.recorded ?? 0} of {summary?.days ?? 0}
          </dd>
        </div>
        <div className="card-fact">
          <dt>Working days still empty</dt>
          <dd className="card-fact-numeric">{summary?.workingDaysNotRecorded ?? 0}</dd>
        </div>
        <div className="card-fact">
          <dt>Files found</dt>
          <dd className="card-fact-numeric">{report.timesheets.length}</dd>
        </div>
      </dl>

      {report.cacheFailure === null ? null : (
        <StateNotice
          state="local-storage-unavailable"
          scope="section"
          detail="Google Sheets was read successfully; only this browser's copy could not be written."
        />
      )}

      {report.unreadable.length === 0 ? null : (
        <StateNotice
          state="provider-failure"
          scope="section"
          detail={`${report.unreadable.length} attendance ${
            report.unreadable.length === 1 ? "file" : "files"
          } could not be read, so the file count above may be incomplete.`}
        />
      )}
    </>
  );
}
