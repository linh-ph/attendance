"use client";

import Link from "next/link";
import type { RecentFile } from "@/lib/dashboard/local-records";

/**
 * Sheets this browser profile opened recently, newest first.
 *
 * Purely a convenience list held in browser-local storage. It is never an
 * access decision: following an entry lands on a route that re-authorizes the
 * request, so a stale entry for a file the user has since lost access to is
 * refused there.
 */

export interface RecentFilesProps {
  entries: readonly RecentFile[];
}

function hrefFor(entry: RecentFile): string {
  return entry.sheetId === ""
    ? `/files/${entry.fileId}/members`
    : `/files/${entry.fileId}/attendance/${entry.sheetId}`;
}

export function RecentFiles({ entries }: RecentFilesProps) {
  if (entries.length === 0) return null;

  return (
    <nav className="recent-files" aria-label="Recently opened">
      <h3 className="recent-files-title">Recently opened</h3>

      <ul className="recent-files-list">
        {entries.map((entry) => (
          <li key={`${entry.fileId}:${entry.sheetId}`}>
            <Link href={hrefFor(entry)}>
              {entry.name}
              {entry.sheetTitle === "" ? null : (
                <span className="recent-files-tab"> · {entry.sheetTitle}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
