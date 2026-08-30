"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingGhosts } from "@/components/loading-ghosts";
import Link from "next/link";
import { matchTabForEmail } from "@/lib/attendance/tab-match";
import type { Timesheet } from "@/lib/discovery/file-discovery";

/**
 * Opens this person's tab in a file that carries no configuration.
 *
 * The tab list is whatever `/api/dashboard` already returned for this account,
 * so it holds exactly the files and tabs Google lets them reach. When the
 * signed-in address resolves to exactly one of those tabs the browser goes
 * straight there; when it resolves to none, or to more than one, the list is
 * shown and the person picks.
 *
 * Neither path is an access decision: the attendance route re-authorizes every
 * read and write behind it, so the worst a wrong match could do is open a tab
 * Google was already willing to hand over. That is still worth avoiding, which
 * is why an ambiguous address opens nothing.
 */

type LoadState =
  | { status: "loading" }
  | { status: "opening" }
  | { status: "loaded"; timesheet: Timesheet | null }
  | { status: "failed" };

export interface TabChooserProps {
  fileId: string;
  /** The signed-in address, from the server session. */
  email: string;
  /** False when `?choose=1` asked for the list regardless of any match. */
  autoOpen: boolean;
}

export function TabChooser({ fileId, email, autoOpen }: TabChooserProps) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/dashboard", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { timesheets?: Timesheet[] }) => {
        if (cancelled) return;

        const timesheet = (body.timesheets ?? []).find((sheet) => sheet.id === fileId) ?? null;
        const match = autoOpen && timesheet ? matchTabForEmail(email, timesheet.tabs) : null;

        if (match) {
          // `replace`, not `push`: going back should leave this file, not
          // return to a page that would immediately forward again.
          setState({ status: "opening" });
          router.replace(`/files/${fileId}/attendance/${match.sheetId}`);
          return;
        }

        setState({ status: "loaded", timesheet });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [fileId, email, autoOpen, router]);

  if (state.status === "loading") {
    return <LoadingGhosts label="Loading the tabs in this file…" />;
  }

  if (state.status === "opening") {
    return <LoadingGhosts label="Opening your timesheet…" />;
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
