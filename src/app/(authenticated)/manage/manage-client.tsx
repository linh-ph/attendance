"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ErrorNotice } from "@/components/api-error-notice";
import { GooglePicker } from "@/components/google-picker";
import { formatMonthLabel } from "@/components/month-label";
import { LoadingGhosts } from "@/components/loading-ghosts";
import { StateNotice } from "@/components/sync-status";
import {
  clearFolderPreference,
  readFolderPreference,
  writeFolderPreference,
  type FolderPreference,
} from "@/lib/dashboard/folder-preference";
import type { DashboardSetupState, ManagedFile } from "@/lib/discovery/file-discovery";

interface ManageClientProps {
  email: string;
}

interface ManageResponse {
  folder: FolderPreference | null;
  managed: ManagedFile[];
  folderError?: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: ManageResponse }
  | { status: "failed"; message: string; expired: boolean };

const STATUS_LABELS: Record<DashboardSetupState, string> = {
  ready: "Ready",
  "needs-setup": "Needs setup",
  "needs-repair": "Needs repair",
  unknown: "Unavailable",
};

async function loadManaged(folderId: string | null): Promise<LoadState> {
  const url = folderId ? `/api/dashboard?folderId=${encodeURIComponent(folderId)}` : "/api/dashboard";
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { status: "failed", message: "Could not load managed files.", expired: false };
  }

  let body: Record<string, unknown> = {};
  try {
    body = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (response.ok || typeof body.folderError === "string") {
    return {
      status: "loaded",
      data: {
        folder: (body.folder ?? null) as FolderPreference | null,
        managed: Array.isArray(body.managed) ? (body.managed as ManagedFile[]) : [],
        folderError: typeof body.folderError === "string" ? body.folderError : undefined,
      },
    };
  }

  return {
    status: "failed",
    message: typeof body.error === "string" ? body.error : "Could not load managed files.",
    expired: response.status === 401,
  };
}

function modifiedLabel(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

interface ManagedRowProps {
  file: ManagedFile;
  unlocked: boolean;
  pickerError: string | null;
  onConfirm: (fileId: string, selectedId: string) => void;
}

function ManagedRow({ file, unlocked, pickerError, onConfirm }: ManagedRowProps) {
  let action: ReactNode = null;
  if (file.setupState === "ready") {
    action = <Link className="action action-primary" href={`/files/${file.id}/members`}>Open</Link>;
  } else if (file.setupState === "needs-repair") {
    action = <Link className="action action-primary" href={`/files/${file.id}/setup`}>Repair</Link>;
  } else if (file.setupState === "needs-setup" && unlocked) {
    action = <Link className="action action-primary" href={`/files/${file.id}/setup`}>Resume</Link>;
  } else if (file.setupState === "needs-setup") {
    action = (
      <GooglePicker
        mode="spreadsheet"
        label="Confirm file"
        onSelect={(item) => onConfirm(file.id, item.id)}
      />
    );
  }

  return (
    <tr>
      <td data-label="File">
        <strong>{file.name}</strong>
        {file.error ? <p role="alert" className="managed-row-error">{file.error}</p> : null}
        {pickerError ? <p role="alert" className="managed-row-error">{pickerError}</p> : null}
      </td>
      <td data-label="Month" className="tabular">
        {file.month ? formatMonthLabel(file.month) : "Not configured"}
      </td>
      <td data-label="Status">
        <span className={`state-pill state-pill-${file.setupState === "ready" ? "synced" : file.setupState === "unknown" ? "failed" : "pending"}`}>
          {STATUS_LABELS[file.setupState]}
        </span>
      </td>
      <td data-label="Members" className="tabular">
        {file.memberCount === null ? "—" : `${file.memberCount} members`}
      </td>
      <td data-label="Modified" className="tabular">{modifiedLabel(file.modifiedTime)}</td>
      <td data-label="Next action" className="managed-row-action">{action}</td>
    </tr>
  );
}

export function ManageClient({ email }: ManageClientProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<DashboardSetupState | "all">("all");
  const [unlockedId, setUnlockedId] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<{ id: string; message: string } | null>(null);

  const reload = useCallback((folderId: string | null) => {
    setState({ status: "loading" });
    void loadManaged(folderId).then(setState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadManaged(readFolderPreference(email)?.id ?? null).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  const folderError = state.status === "loaded" ? state.data.folderError ?? null : null;
  useEffect(() => {
    if (folderError) clearFolderPreference(email);
  }, [email, folderError]);

  const files = useMemo(
    () => (state.status === "loaded" ? state.data.managed : []),
    [state],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return files.filter((file) => {
      const matchesQuery = normalized === "" || file.name.toLowerCase().includes(normalized);
      const matchesStatus = statusFilter === "all" || file.setupState === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [files, query, statusFilter]);

  function selectFolder(folder: FolderPreference): void {
    writeFolderPreference(email, folder);
    setUnlockedId(null);
    setPickerError(null);
    reload(folder.id);
  }

  function confirmFile(fileId: string, selectedId: string): void {
    if (fileId === selectedId) {
      setUnlockedId(fileId);
      setPickerError(null);
      return;
    }
    setUnlockedId(null);
    setPickerError({ id: fileId, message: "Select this same file in Google Picker to continue setup." });
  }

  if (state.status === "loading") {
    return <LoadingGhosts label="Loading your managed files…" />;
  }

  if (state.status === "failed") {
    return (
      <ErrorNotice
        title={state.message}
        scope="page"
        onRetry={state.expired ? undefined : () => reload(readFolderPreference(email)?.id ?? null)}
        reauthenticate={state.expired}
      />
    );
  }

  const { folder } = state.data;

  return (
    <div className="manage-workspace">
      <section className="manage-context surface-panel" aria-labelledby="manage-context-title">
        <div>
          <p className="eyebrow">Active folder</p>
          <h2 id="manage-context-title">{folder?.name ?? "No folder selected"}</h2>
          <p className="page-lede">This browser remembers the folder; Google re-authorizes every request.</p>
        </div>
        <GooglePicker
          mode="folder"
          label={folder ? "Change folder" : "Select folder"}
          onSelect={selectFolder}
        />
      </section>

      <section className="surface-panel" aria-labelledby="managed-list-title">
        <header className="manage-list-header">
          <div>
            <p className="eyebrow">Management</p>
            <h2 id="managed-list-title">Attendance files</h2>
          </div>
          <div className="manage-actions">
            <Link className="action action-primary" href="/files/new">Create monthly file</Link>
            <Link className="action" href="/files/import">Import XLSX</Link>
            <Link className="action" href="/members">Members</Link>
          </div>
        </header>

        {folderError ? (
          <StateNotice
            state="folder-unavailable"
            title="Choose another folder"
            detail={folderError}
          />
        ) : null}

        {folder === null ? (
          <p className="empty-state">Choose a folder to see managed attendance files.</p>
        ) : (
          <>
            <div className="manage-filters">
              <label>
                <span>Search</span>
                <input
                  type="search"
                  aria-label="Search managed files"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="File name"
                />
              </label>
              <label>
                <span>Status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DashboardSetupState | "all") }>
                  <option value="all">All statuses</option>
                  <option value="ready">Ready</option>
                  <option value="needs-setup">Needs setup</option>
                  <option value="needs-repair">Needs repair</option>
                  <option value="unknown">Unavailable</option>
                </select>
              </label>
            </div>

            {files.length === 0 ? (
              <StateNotice state="no-managed-files" />
            ) : filtered.length === 0 ? (
              <p className="empty-state">No files match these filters.</p>
            ) : (
              <div className="managed-table-wrap">
                <table className="managed-table">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Month</th>
                      <th scope="col">Status</th>
                      <th scope="col">Members</th>
                      <th scope="col">Modified</th>
                      <th scope="col">Next action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((file) => (
                      <ManagedRow
                        key={file.id}
                        file={file}
                        unlocked={unlockedId === file.id}
                        pickerError={pickerError?.id === file.id ? pickerError.message : null}
                        onConfirm={confirmFile}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
