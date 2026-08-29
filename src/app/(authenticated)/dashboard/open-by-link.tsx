"use client";

import { useState } from "react";
import { resolveSheetLink, type DashboardLists } from "@/lib/dashboard/link-resolver";
import type { LocalStore } from "@/lib/dashboard/local-store";

/**
 * Paste a Google Sheets link to jump straight to a file.
 *
 * A shortcut only: the link is resolved against the files this dashboard
 * already listed, and that listing was computed on the server after
 * authorization. A link to a file the user cannot open reports that plainly
 * instead of navigating, and the destination route re-authorizes regardless.
 */

export const NOT_A_LINK_MESSAGE =
  "That is not a Google Sheets link. Paste the full link from your browser's address bar.";

export const NO_ACCESS_MESSAGE =
  "You do not have permission to open this file, or it is not set up for attendance yet.";

export interface OpenByLinkProps {
  email: string;
  lists: DashboardLists;
  store: LocalStore;
  /** Injected in tests; the browser navigates for real. */
  navigate?: (href: string) => void;
}

export function OpenByLink({ email, lists, store, navigate }: OpenByLinkProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function go(href: string): void {
    if (navigate) {
      navigate(href);
      return;
    }
    window.location.assign(href);
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const resolution = resolveSheetLink(value, lists);

    if (resolution.kind === "not-a-link") {
      setError(NOT_A_LINK_MESSAGE);
      return;
    }

    if (resolution.kind === "no-access") {
      setError(NO_ACCESS_MESSAGE);
      return;
    }

    setError(null);

    // Remembering the visit must never block or fail the navigation.
    void store
      .addRecent(email, {
        fileId: resolution.fileId,
        sheetId: resolution.kind === "timesheet" ? (resolution.sheetId ?? "") : "",
        name: resolution.name,
        sheetTitle: resolution.kind === "timesheet" ? resolution.sheetTitle : "",
        openedAt: new Date().toISOString(),
      })
      .catch(() => undefined)
      .finally(() => go(resolution.href));
  }

  return (
    <form className="open-by-link" onSubmit={submit}>
      <label htmlFor="sheet-link">Open by Google Sheets link</label>

      <div className="open-by-link-row">
        <input
          id="sheet-link"
          name="sheet-link"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
        <button type="submit" disabled={value.trim() === ""}>
          Open
        </button>
      </div>

      {error ? (
        <p role="alert" className="open-by-link-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
