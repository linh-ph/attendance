"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GooglePicker } from "@/components/google-picker";
import {
  clearFolderPreference,
  readFolderPreference,
  writeFolderPreference,
  type FolderPreference,
} from "@/lib/dashboard/folder-preference";
import type { DashboardSetupState, ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";

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

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: DashboardResponse }
  | { status: "failed"; message: string; canRetry: boolean };

const SESSION_EXPIRED = "Your Google session expired. Sign in again to continue.";
const LOAD_FAILED = "Could not load your dashboard.";
const PICKER_MISMATCH = "Select this same file in Google Picker to start setup.";

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
}

function CardFact({ label, value }: CardFactProps) {
  if (value === null) return null;

  return (
    <div className="card-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
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
        <CardFact label="Month" value={formatMonth(file.month)} />
        <CardFact label="Owner" value={file.ownerEmail} />
        <CardFact
          label="Members"
          value={file.memberCount === null ? null : `${file.memberCount} members`}
        />
        <CardFact label="Modified" value={formatTimestamp(file.modifiedTime)} />
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
    <li className="card" aria-label={`${timesheet.name} — ${timesheet.sheetTitle}`}>
      <h3 className="card-title">{timesheet.name}</h3>

      <dl className="card-facts">
        <CardFact label="Your tab" value={timesheet.sheetTitle} />
        <CardFact label="Month" value={formatMonth(timesheet.month)} />
        <CardFact label="Owner" value={timesheet.ownerEmail} />
        <CardFact label="Modified" value={formatTimestamp(timesheet.modifiedTime)} />
      </dl>

      <div className="card-actions">
        <a
          className="action action-primary"
          href={`/files/${timesheet.id}/attendance/${timesheet.sheetId}`}
        >
          Open timesheet
        </a>
        <a
          className="action"
          href={spreadsheetUrl(timesheet.id, timesheet.sheetId)}
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

  let body: DashboardResponse | null = null;
  try {
    body = (await response.json()) as DashboardResponse;
  } catch {
    body = null;
  }

  // A folder failure still carries the employee section, so the body wins over
  // the status for everything except an outright server error.
  if (body && (response.ok || typeof body.folderError === "string")) {
    return { status: "loaded", data: body };
  }

  return { status: "failed", message: LOAD_FAILED, canRetry: true };
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export function DashboardClient({ email }: DashboardClientProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [unlockedSetupFileId, setUnlockedSetupFileId] = useState<string | null>(null);
  const [pickerErrorFileId, setPickerErrorFileId] = useState<string | null>(null);

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
    setPickerErrorFileId(null);
    reload(folder.id);
  }

  function confirmSetupFile(fileId: string, pickedId: string): void {
    // The Picker grant must be for this same file; a different pick proves nothing.
    if (pickedId === fileId) {
      setUnlockedSetupFileId(fileId);
      setPickerErrorFileId(null);
      return;
    }

    setUnlockedSetupFileId(null);
    setPickerErrorFileId(fileId);
  }

  if (state.status === "loading") {
    return (
      <main className="dashboard">
        <p>Loading your attendance files…</p>
      </main>
    );
  }

  if (state.status === "failed") {
    return (
      <main className="dashboard">
        <p role="alert" className="page-error">
          {state.message}
        </p>
        {state.canRetry ? (
          <button type="button" onClick={() => reload(readFolderPreference(email)?.id ?? null)}>
            Retry
          </button>
        ) : null}
      </main>
    );
  }

  const { folder, managed, timesheets } = state.data;

  return (
    <main className="dashboard">
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
                pickerError={pickerErrorFileId === file.id ? PICKER_MISMATCH : null}
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
    </main>
  );
}
