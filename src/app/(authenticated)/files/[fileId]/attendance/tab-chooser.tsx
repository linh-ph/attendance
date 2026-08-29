"use client";

import { useEffect, useState } from "react";
import { LoadingGhosts } from "@/components/loading-ghosts";
import Link from "next/link";
import type { Timesheet } from "@/lib/discovery/file-discovery";

/**
 * Lists the tabs of one file so the person can open their own.
 *
 * The list is whatever `/api/dashboard` already returned for this account, so
 * it shows exactly the files and tabs Google lets them reach. Choosing a tab
 * is not an access decision: the attendance route re-authorizes every read and
 * write behind it.
 */

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; timesheet: Timesheet | null }
  | { status: "failed" };

export interface TabChooserProps {
  fileId: string;
}

export function TabChooser({ fileId }: TabChooserProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/dashboard", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { timesheets?: Timesheet[] }) => {
        if (cancelled) return;
        const timesheet = (body.timesheets ?? []).find((sheet) => sheet.id === fileId) ?? null;
        setState({ status: "loaded", timesheet });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (state.status === "loading") {
    return <LoadingGhosts label="Loading the tabs in this file…" />;
  }

  if (state.status === "failed") {
    return (
      <p role="alert" className="page-error">
        Could not read the tabs in this file.
      </p>
    );
  }

  if (!state.timesheet) {
    return (
      <p role="alert" className="page-error">
        You do not have permission to open this file, or it is not an attendance file.
      </p>
    );
  }

  return (
    <>
      <p className="page-lede">
        {state.timesheet.name} has no attendance configuration, so pick the tab that holds
        your hours.
      </p>

      <ul className="card-list">
        {state.timesheet.tabs.map((tab) => (
          <li className="card" key={tab.sheetId}>
            <h2 className="card-title">{tab.title}</h2>
            <div className="card-actions">
              <Link
                className="action action-primary"
                href={`/files/${fileId}/attendance/${tab.sheetId}`}
              >
                Open this tab
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
