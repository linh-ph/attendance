"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorNotice } from "@/components/api-error-notice";
import { formatMonthLabel } from "@/components/month-label";
import { LoadingGhosts } from "@/components/loading-ghosts";
import { StateNotice } from "@/components/sync-status";
import type { ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import type { RecentFile } from "@/lib/dashboard/local-records";
import { resolveLocalStore, type LocalStore } from "@/lib/dashboard/local-store";
import { OpenByLink } from "../dashboard/open-by-link";
import { RecentFiles } from "../dashboard/recent-files";

interface TimesheetsClientProps {
  email: string;
  store?: LocalStore;
}

interface DashboardLists {
  managed: ManagedFile[];
  timesheets: Timesheet[];
}

type State =
  | { status: "loading" }
  | { status: "loaded"; lists: DashboardLists }
  | { status: "failed"; message: string; expired: boolean };

async function loadTimesheets(): Promise<State> {
  let response: Response;
  try {
    response = await fetch("/api/dashboard", { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { status: "failed", message: "Could not load your timesheets.", expired: false };
  }

  let body: Record<string, unknown> = {};
  try {
    body = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (response.ok && Array.isArray(body.timesheets) && Array.isArray(body.managed)) {
    return {
      status: "loaded",
      lists: { timesheets: body.timesheets as Timesheet[], managed: body.managed as ManagedFile[] },
    };
  }

  return {
    status: "failed",
    message: typeof body.error === "string" ? body.error : "Could not load your timesheets.",
    expired: response.status === 401,
  };
}

function modifiedLabel(value: string | null): string {
  if (!value) return "Modified time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Modified time unavailable";
  return `Modified ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date)}`;
}

function TimesheetRow({ timesheet }: { timesheet: Timesheet }) {
  const href = timesheet.sheetId === null
    ? `/files/${timesheet.id}/attendance`
    : `/files/${timesheet.id}/attendance/${timesheet.sheetId}`;

  return (
    <li className="timesheet-row">
      <div className="timesheet-row-date" aria-hidden="true">
        <span>{timesheet.month?.slice(5) ?? "—"}</span>
        <small>{timesheet.month?.slice(0, 4) ?? "File"}</small>
      </div>
      <div className="timesheet-row-main">
        <h3>{timesheet.name}</h3>
        <p>{timesheet.sheetTitle ?? `${timesheet.tabs.length} visible tabs`}</p>
        <p className="timesheet-row-meta">{timesheet.ownerEmail}</p>
        <p className="timesheet-row-meta">{modifiedLabel(timesheet.modifiedTime)}</p>
      </div>
      <Link className="action action-primary" href={href}>
        {timesheet.sheetId === null ? "Choose your tab" : "Open timesheet"}
      </Link>
    </li>
  );
}

export function TimesheetsClient({ email, store: storeProp }: TimesheetsClientProps) {
  const [store] = useState(() => storeProp ?? resolveLocalStore());
  const [state, setState] = useState<State>({ status: "loading" });
  const [recent, setRecent] = useState<RecentFile[]>([]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    void loadTimesheets().then(setState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadTimesheets().then((next) => {
      if (!cancelled) setState(next);
    });
    void store.readRecent(email).then((entries) => {
      if (!cancelled) setRecent(entries);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [email, store]);

  if (state.status === "loading") {
    return <LoadingGhosts label="Loading your timesheets…" />;
  }

  if (state.status === "failed") {
    return (
      <ErrorNotice
        title={state.message}
        scope="page"
        onRetry={state.expired ? undefined : reload}
        reauthenticate={state.expired}
      />
    );
  }

  const sorted = [...state.lists.timesheets].sort((left, right) =>
    (right.month ?? "").localeCompare(left.month ?? ""),
  );

  return (
    <div className="timesheets-workspace">
      <section className="surface-panel timesheet-list-panel" aria-labelledby="timesheet-list-title">
        <div className="section-header">
          <h2 id="timesheet-list-title">Your attendance months</h2>
        </div>

        {sorted.length === 0 ? (
          <StateNotice state="no-timesheet" title="No timesheet for this month" />
        ) : (
          <div className="timesheet-groups">
            {sorted.map((timesheet) => (
              <section key={`${timesheet.id}:${timesheet.sheetId}`} aria-labelledby={`month-${timesheet.id}-${timesheet.sheetId ?? "choose"}`}>
                <h2 id={`month-${timesheet.id}-${timesheet.sheetId ?? "choose"}`}>
                  {timesheet.month ? formatMonthLabel(timesheet.month) : "Month not configured"}
                </h2>
                <ul className="timesheet-list">
                  <TimesheetRow timesheet={timesheet} />
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>

      <aside className="timesheet-utilities" aria-label="Timesheet utilities">
        <details className="open-by-link-disclosure" aria-label="Open by link">
          <summary>Open by link</summary>
          <div className="open-file-panel">
            <OpenByLink email={email} lists={state.lists} store={store} />
          </div>
        </details>
        <section className="surface-panel" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent files</h2>
          {recent.length === 0 ? (
            <p className="empty-state">Files you open will appear here for this signed-in account.</p>
          ) : (
            <RecentFiles entries={recent} />
          )}
        </section>
      </aside>
    </div>
  );
}
