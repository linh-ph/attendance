"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GooglePicker } from "@/components/google-picker";
import { LoadingGhosts } from "@/components/loading-ghosts";
import {
  clearFolderPreference,
  readFolderPreference,
  writeFolderPreference,
  type FolderPreference,
} from "@/lib/dashboard/folder-preference";
import type { DashboardSetupState, ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import { resolveLocalStore, type LocalStore } from "@/lib/dashboard/local-store";
import type { RecentFile } from "@/lib/dashboard/local-records";
import { OpenByLink } from "./open-by-link";
import { RecentFiles } from "./recent-files";
import type { GoogleErrorDiagnostic } from "@/lib/google/errors";

/**
 * Role-aware dashboard.
 *
 * The remembered folder is a browser-only convenience: it is sent as a query
 * parameter and the server revalidates it on every request. When the server
 * reports the folder is unavailable, the message is rendered first and the
 * stored preference is cleared afterwards, in an effect that runs after commit.
 */

interface DashboardClientProps {
  /** Normalized signed-in email; scopes the local folder preference only. */
  email: string;
}

interface DashboardResponse {
  folder: FolderPreference | null;
  managed: ManagedFile[];
  timesheets: Timesheet[];
  folderError?: string;
}

interface DashboardErrorResponse {
  error?: string;
  debug?: GoogleErrorDiagnostic;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: DashboardResponse }
  | {
      status: "failed";
      message: string;
      canRetry: boolean;
      debug?: GoogleErrorDiagnostic;
    };

const SESSION_EXPIRED = "Your Google session expired. Sign in again to continue.";
const LOAD_FAILED = "Could not load your dashboard.";
const PICKER_MISMATCH = "Select this same file in Google Picker to start setup.";

/**
 * Shown when the manager picked a file this dashboard never listed for them:
 * the pick proves no access, so setup must not be unlocked.
 */
const PICKER_NO_ACCESS =
  "You do not have permission to set up that file. Pick a file you own from this folder.";

const SETUP_STATE_LABELS: Record<DashboardSetupState, string> = {
  ready: "Ready",
  "needs-setup": "Needs setup",
  "needs-repair": "Needs repair",
  unknown: "Unavailable",
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** `YYYY-MM` becomes a readable English label such as `July 2026`. */
function formatMonth(month: string | null): string | null {
  if (month === null) return null;

  const [year, monthNumber] = month.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) return null;

  return MONTH_FORMAT.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function formatTimestamp(isoTime: string | null): string | null {
  if (isoTime === null) return null;

  const parsed = new Date(isoTime);
  if (Number.isNaN(parsed.getTime())) return null;

  return `${TIMESTAMP_FORMAT.format(parsed)} UTC`;
}

function spreadsheetUrl(fileId: string, sheetId?: string): string {
  const base = `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  return sheetId === undefined ? base : `${base}#gid=${sheetId}`;
}

/* -------------------------------------------------------------------------- */
/* Card fragments                                                              */
/* -------------------------------------------------------------------------- */

interface CardFactProps {
  label: string;
  value: string | null;
  /** Months, counts, and timestamps get the tabular monospaced treatment. */
  numeric?: boolean;
}

/**
 * `numeric` opts a fact into the monospaced, tabular treatment. It is for
 * months, counts, and timestamps — values that read as a column. Names and
 * email addresses stay in the UI face, where they wrap on word boundaries
 * instead of breaking mid-address.
 */
function CardFact({ label, value, numeric }: CardFactProps) {
  if (value === null) return null;

  return (
    <div className="card-fact">
      <dt>{label}</dt>
      <dd className={numeric ? "card-fact-numeric" : undefined}>{value}</dd>
    </div>
  );
}

interface ManagedCardProps {
  file: ManagedFile;
  /** Set once the manager re-selected this exact file in the spreadsheet Picker. */
  isSetupUnlocked: boolean;
  pickerError: string | null;
  onSetupPicked: (fileId: string, pickedId: string) => void;
}

function ManagedCard({ file, isSetupUnlocked, pickerError, onSetupPicked }: ManagedCardProps) {
  const isReady = file.setupState === "ready";
  const needsSetup = file.setupState === "needs-setup";

  return (
    <li className="card" aria-label={file.name}>
      <h3 className="card-title">{file.name}</h3>
      <p className={`card-state card-state-${file.setupState}`}>
        {SETUP_STATE_LABELS[file.setupState]}
      </p>

      <dl className="card-facts">
        <CardFact label="Month" value={formatMonth(file.month)} numeric />
        <CardFact label="Owner" value={file.ownerEmail} />
        <CardFact
          label="Members"
          value={file.memberCount === null ? null : `${file.memberCount} members`}
          numeric
        />
        <CardFact label="Modified" value={formatTimestamp(file.modifiedTime)} numeric />
      </dl>

      {file.error ? (
        <p role="alert" className="card-error">
          {file.error}
        </p>
      ) : null}

      <div className="card-actions">
        {isReady ? (
          <>
            <a className="action action-primary" href={`/files/${file.id}/members`}>
              Open
            </a>
            <a className="action" href={`/files/${file.id}/members#add-member`}>
              Manage members
            </a>
          </>
        ) : null}

        <a
          className="action"
          href={spreadsheetUrl(file.id)}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in Google Sheets
        </a>

        {needsSetup && !isSetupUnlocked ? (
          <GooglePicker
            mode="spreadsheet"
            label="Set up"
            onSelect={(item) => onSetupPicked(file.id, item.id)}
          />
        ) : null}

        {needsSetup && isSetupUnlocked ? (
          <a className="action action-primary" href={`/files/${file.id}/setup`}>
            Continue setup
          </a>
        ) : null}
      </div>

      {pickerError ? (
        <p role="alert" className="card-error">
          {pickerError}
        </p>
      ) : null}
    </li>
  );
}

function TimesheetCard({ timesheet }: { timesheet: Timesheet }) {
  return (
    /*
      Several files can share a name and a tab title now that every reachable
      file is listed, so the owner is part of the accessible name to keep each
      card distinguishable.
    */
    <li
      className="card"
      aria-label={[timesheet.name, timesheet.sheetTitle, timesheet.ownerEmail]
        .filter((part) => part !== null && part !== "")
        .join(" — ")}
    >
      <h3 className="card-title">{timesheet.name}</h3>

      <dl className="card-facts">
        <CardFact
          label="Your tab"
          value={timesheet.sheetTitle ?? `${timesheet.tabs.length} tabs to choose from`}
        />
        <CardFact label="Month" value={formatMonth(timesheet.month)} numeric />
        <CardFact label="Owner" value={timesheet.ownerEmail} />
        <CardFact label="Modified" value={formatTimestamp(timesheet.modifiedTime)} numeric />
      </dl>

      <div className="card-actions">
        {/*
          A configured file opens straight at the mapped tab. Without a
          configuration there is nothing that says which tab is this person's,
          so they choose it instead of the app guessing.
        */}
        <a
          className="action action-primary"
          href={
            timesheet.sheetId === null
              ? `/files/${timesheet.id}/attendance`
              : `/files/${timesheet.id}/attendance/${timesheet.sheetId}`
          }
        >
          {timesheet.sheetId === null ? "Choose your tab" : "Open timesheet"}
        </a>
        <a
          className="action"
          href={spreadsheetUrl(timesheet.id, timesheet.sheetId ?? undefined)}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in Google Sheets
        </a>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Data loading                                                                */
/* -------------------------------------------------------------------------- */

async function fetchDashboard(folderId: string | null): Promise<LoadState> {
  const url = folderId === null ? "/api/dashboard" : `/api/dashboard?folderId=${encodeURIComponent(folderId)}`;

  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { status: "failed", message: LOAD_FAILED, canRetry: true };
  }

  if (response.status === 401) {
    return { status: "failed", message: SESSION_EXPIRED, canRetry: false };
  }

  let body: (DashboardResponse & DashboardErrorResponse) | null = null;
  try {
    body = (await response.json()) as DashboardResponse & DashboardErrorResponse;
  } catch {
    body = null;
  }

  // A folder failure still carries the employee section, so the body wins over
  // the status for everything except an outright server error.
  if (body && (response.ok || typeof body.folderError === "string")) {
    return { status: "loaded", data: body };
  }

  return {
    status: "failed",
    message: typeof body?.error === "string" ? body.error : LOAD_FAILED,
    canRetry: true,
    ...(body?.debug ? { debug: body.debug } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export function DashboardClient({ email }: DashboardClientProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [unlockedSetupFileId, setUnlockedSetupFileId] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<{ fileId: string; message: string } | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [store] = useState<LocalStore>(() => resolveLocalStore());

  /**
   * Reload from an event handler. Showing `loading` synchronously is correct
   * here — the user just asked for it — which is why this is not reused by the
   * mount effect below.
   */
  const reload = useCallback((folderId: string | null) => {
    setState({ status: "loading" });
    void fetchDashboard(folderId).then(setState);
  }, []);

  /**
   * Initial load. The remembered folder lives in browser storage, so the first
   * read can only happen after mount. State is set from the promise
   * continuation rather than the effect body, and a superseded run is
   * discarded so a slow response for a previous email can never overwrite a
   * newer one.
   */
  useEffect(() => {
    let cancelled = false;

    void fetchDashboard(readFolderPreference(email)?.id ?? null).then((next) => {
      if (!cancelled) {
        setState(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [email]);

  /**
   * Recently opened sheets come from browser-local storage, so they can only
   * be read after mount. Same pattern as the load above: the state is set from
   * the promise continuation and a superseded run is discarded.
   */
  useEffect(() => {
    let cancelled = false;

    void store
      .readRecent(email)
      .catch(() => [] as RecentFile[])
      .then((entries) => {
        if (!cancelled) setRecent(entries);
      });

    return () => {
      cancelled = true;
    };
  }, [email, store]);

  const folderError = state.status === "loaded" ? (state.data.folderError ?? null) : null;

  // Runs after the message is committed to the DOM, never before.
  useEffect(() => {
    if (folderError !== null) {
      clearFolderPreference(email);
    }
  }, [email, folderError]);

  function selectFolder(folder: FolderPreference): void {
    writeFolderPreference(email, folder);
    setUnlockedSetupFileId(null);
    setPickerError(null);
    reload(folder.id);
  }

  function confirmSetupFile(fileId: string, pickedId: string): void {
    // The Picker grant must be for this same file; a different pick proves nothing.
    if (pickedId === fileId) {
      setUnlockedSetupFileId(fileId);
      setPickerError(null);
      return;
    }

    setUnlockedSetupFileId(null);

    // A pick outside this manager's own listing is a permission problem, not a
    // mismatch, and deserves a message that says so.
    const listed =
      state.status === "loaded" &&
      state.data.managed.some((candidate) => candidate.id === pickedId);

    setPickerError({ fileId, message: listed ? PICKER_MISMATCH : PICKER_NO_ACCESS });
  }

  if (state.status === "loading") {
    return (
      <div className="dashboard">
        <LoadingGhosts label="Loading your attendance files…" />
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="dashboard">
        <p role="alert" className="page-error">
          {state.message}
        </p>
        {state.debug ? (
          <pre aria-label="Debug error details" className="debug-error">
            {JSON.stringify(state.debug, null, 2)}
          </pre>
        ) : null}
        {state.canRetry ? (
          <button type="button" onClick={() => reload(readFolderPreference(email)?.id ?? null)}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const { folder, managed, timesheets } = state.data;

  return (
    <div className="dashboard">
      <section className="section" aria-labelledby="shortcut-heading">
        <header className="section-header">
          <h2 id="shortcut-heading">Open a file</h2>
        </header>

        <div className="open-file-panel">
          <OpenByLink email={email} lists={{ managed, timesheets }} store={store} />
          <RecentFiles entries={recent} />
        </div>
      </section>

      <section className="section" aria-labelledby="managed-heading">
        <header className="section-header">
          <h2 id="managed-heading">Managed attendance files</h2>

          <div className="folder-control">
            {folder ? <p className="folder-name">{folder.name}</p> : null}
            <GooglePicker
              mode="folder"
              label={folder ? "Change folder" : "Select dashboard folder"}
              onSelect={selectFolder}
            />
          </div>

          {/* Entry points to the manager wizards. Both confirm the destination
              folder themselves, so they stay reachable before one is chosen. */}
          <div className="section-actions">
            <Link className="action action-primary" href="/files/new">
              Create monthly file
            </Link>
            <Link className="action" href="/files/import">
              Import workbook
            </Link>
            {/* The browser's own roster, which the create wizard offers as
                shortcuts. It belongs beside the wizards that consume it. */}
            <Link className="action" href="/members">
              Members
            </Link>
          </div>
        </header>

        {folderError ? (
          <p role="alert" className="section-error">
            {folderError}
          </p>
        ) : null}

        {folder === null ? (
          <p className="empty-state">
            Select a dashboard folder to see the attendance files you manage.
          </p>
        ) : null}

        {folder !== null && managed.length === 0 ? (
          <p className="empty-state">No attendance files in this folder.</p>
        ) : null}

        {managed.length > 0 ? (
          <ul className="card-list">
            {managed.map((file) => (
              <ManagedCard
                key={file.id}
                file={file}
                isSetupUnlocked={unlockedSetupFileId === file.id}
                pickerError={pickerError?.fileId === file.id ? pickerError.message : null}
                onSetupPicked={confirmSetupFile}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="section" aria-labelledby="timesheets-heading">
        <header className="section-header">
          <h2 id="timesheets-heading">My timesheets</h2>
        </header>

        {timesheets.length === 0 ? (
          <p className="empty-state">No timesheets are shared with you yet.</p>
        ) : (
          <ul className="card-list">
            {timesheets.map((timesheet) => (
              <TimesheetCard key={`${timesheet.id}:${timesheet.sheetId}`} timesheet={timesheet} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
