"use client";

import { useEffect, useState, type FormEvent } from "react";
import { GooglePicker } from "@/components/google-picker";
import { MemberRows } from "@/components/member-rows";
import { readFolderPreference, type FolderPreference } from "@/lib/dashboard/folder-preference";
import type { MemberSummary } from "@/lib/files/member-service";
import type { MemberSetupProgress } from "@/lib/files/setup-service";

/**
 * Explicit setup for an attendance file this app did not create.
 *
 * Section 5.3 of the approved design: a `Needs setup` file stays read-only
 * until the manager re-selects that exact file in Google Picker, because that
 * selection — not metadata discovery — is what grants the app access to it.
 * This component therefore reads nothing and sends nothing until the picked ID
 * equals this route's file ID, and the server enforces the same rule again.
 *
 * The existing tabs are only mapped, never rebuilt: the wizard asks for one
 * name and email per employee sheet the file already has. A partially
 * configured file keeps its tabs, mappings, and protections, and `Retry setup`
 * repeats the identical request so setup resumes where it stopped.
 */

const PICKER_MISMATCH = "Select this same file in Google Picker to start setup.";
const FOLDER_REQUIRED =
  "Select your dashboard folder on the dashboard before setting up this file.";
const UNTRUSTED_CONFIG =
  "This file already has a configuration sheet. Setup replaces it with the current one.";
const MONTH_INVALID = "Enter the attendance month as YYYY-MM.";
const MAPPING_INCOMPLETE = "Assign a name and a Google Workspace email to every sheet.";
const MAPPING_DUPLICATE = "Assign each sheet to a different member.";
const LOAD_FAILED = "Could not read the sheets in this file.";
const SAVE_FAILED = "Could not set up this attendance file.";
const COMPLETE_NOTICE = "Setup complete. This file is ready.";
const PARTIAL_NOTICE = "Setup is incomplete. Retry setup to finish sharing this file.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/* -------------------------------------------------------------------------- */
/* API contract                                                                */
/* -------------------------------------------------------------------------- */

export interface LegacySheet {
  sheetId: string;
  title: string;
}

export interface LegacySetupInspection {
  file: { id: string; name: string; month: string | null };
  folder: FolderPreference;
  sheets: LegacySheet[];
  hasUntrustedConfig: boolean;
  members: MemberSetupProgress[];
}

export interface LegacySetupResult {
  file: { id: string; name: string; month: string; setupState: string; complete: boolean };
  folder: FolderPreference;
  members: MemberSetupProgress[];
}

export interface ConfigureExistingRequest {
  /** Proof that this same file was selected in Google Picker. */
  pickedFileId: string;
  folderId: string;
  month: string;
  mappings: { sheetId: string; displayName: string; email: string }[];
}

export interface LegacySetupApi {
  inspect(
    fileId: string,
    input: { folderId: string; pickedFileId: string },
  ): Promise<LegacySetupInspection>;
  configure(fileId: string, input: ConfigureExistingRequest): Promise<LegacySetupResult>;
}

/* -------------------------------------------------------------------------- */
/* Default browser client                                                      */
/* -------------------------------------------------------------------------- */

function setupUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/setup`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  // 207 means the file was configured but at least one invitation failed; the
  // body still carries the retained IDs, so it is a success for the caller.
  if (!response.ok && response.status !== 207) {
    const envelope = (body ?? {}) as { error?: string };
    throw new Error(envelope.error ?? SAVE_FAILED);
  }

  return body as T;
}

export const legacySetupApiClient: LegacySetupApi = {
  inspect: (fileId, input) =>
    requestJson<LegacySetupInspection>(
      `${setupUrl(fileId)}?folderId=${encodeURIComponent(input.folderId)}&pickedFileId=${encodeURIComponent(
        input.pickedFileId,
      )}`,
    ),
  configure: (fileId, input) =>
    requestJson<LegacySetupResult>(setupUrl(fileId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface MappingRow {
  displayName: string;
  email: string;
}

type MappingRows = Record<string, MappingRow>;

/** Prefills from the progress an earlier attempt already recorded. */
function initialRows(inspection: LegacySetupInspection): MappingRows {
  const bySheetId = new Map(
    inspection.members.flatMap((member) =>
      member.sheetId === null ? [] : [[member.sheetId, member] as const],
    ),
  );

  return Object.fromEntries(
    inspection.sheets.map((sheet) => {
      const member = bySheetId.get(sheet.sheetId);
      return [
        sheet.sheetId,
        { displayName: member?.displayName ?? "", email: member?.email ?? "" },
      ];
    }),
  );
}

function toSummary(member: MemberSetupProgress): MemberSummary {
  return {
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    setupStatus: member.setupStatus,
    invitationSent: member.permissionId !== null,
  };
}

/**
 * The remembered folder, which only exists in browser storage.
 *
 * `checking` is a distinct state from "no folder remembered": the value cannot
 * be read while rendering, so the wizard must not accuse the manager of having
 * no folder before it has actually looked.
 */
type FolderState = { status: "checking" } | { status: "ready"; folder: FolderPreference | null };

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/**
 * Builds the request, or the reason it is not yet valid. Rejected in the
 * browser so an obviously incomplete mapping never reaches Google; the server
 * validates the same request again.
 */
function buildRequest(
  fileId: string,
  folderId: string,
  month: string,
  sheets: readonly LegacySheet[],
  rows: MappingRows,
): { request: ConfigureExistingRequest } | { error: string } {
  if (!MONTH_PATTERN.test(month)) {
    return { error: MONTH_INVALID };
  }

  const mappings = sheets.map((sheet) => {
    const row = rows[sheet.sheetId] ?? { displayName: "", email: "" };
    return {
      sheetId: sheet.sheetId,
      displayName: row.displayName.trim(),
      email: row.email.trim().toLowerCase(),
    };
  });

  const isIncomplete = mappings.some(
    (mapping) => mapping.displayName === "" || !EMAIL_PATTERN.test(mapping.email),
  );
  if (isIncomplete) {
    return { error: MAPPING_INCOMPLETE };
  }

  if (new Set(mappings.map((mapping) => mapping.email)).size !== mappings.length) {
    return { error: MAPPING_DUPLICATE };
  }

  return { request: { pickedFileId: fileId, folderId, month, mappings } };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface LegacySetupWizardProps {
  fileId: string;
  /** Normalized signed-in email; scopes the local folder preference only. */
  email: string;
  /** Injected in tests; the browser uses the fetch client by default. */
  api?: LegacySetupApi;
}

export function LegacySetupWizard({
  fileId,
  email,
  api = legacySetupApiClient,
}: LegacySetupWizardProps) {
  const [folderState, setFolderState] = useState<FolderState>({ status: "checking" });
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [inspection, setInspection] = useState<LegacySetupInspection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [month, setMonth] = useState("");
  const [rows, setRows] = useState<MappingRows>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<ConfigureExistingRequest | null>(null);
  const [result, setResult] = useState<LegacySetupResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /**
   * The remembered folder is a browser-only convenience and the server
   * revalidates it on every request. State is set from the continuation rather
   * than the effect body, and a superseded run is discarded so a stale read for
   * a previous email can never overwrite a newer one.
   */
  useEffect(() => {
    let cancelled = false;

    void Promise.resolve().then(() => {
      if (!cancelled) {
        setFolderState({ status: "ready", folder: readFolderPreference(email) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [email]);

  function confirmFile(pickedFileId: string, folderId: string): void {
    // The Picker grant must be for this same file; a different pick proves nothing.
    if (pickedFileId !== fileId) {
      setPickerError(PICKER_MISMATCH);
      return;
    }

    setPickerError(null);
    setIsConfirmed(true);

    void api
      .inspect(fileId, { folderId, pickedFileId })
      .then((loaded) => {
        setInspection(loaded);
        setMonth(loaded.file.month ?? "");
        setRows(initialRows(loaded));
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(messageOf(error, LOAD_FAILED)));
  }

  function updateRow(sheetId: string, patch: Partial<MappingRow>): void {
    setRows((current) => ({
      ...current,
      [sheetId]: { ...(current[sheetId] ?? { displayName: "", email: "" }), ...patch },
    }));
  }

  async function send(request: ConfigureExistingRequest): Promise<void> {
    setIsSaving(true);
    setFormError(null);

    try {
      setResult(await api.configure(fileId, request));
      setLastRequest(request);
    } catch (error) {
      // The typed mappings stay on the page so the manager can retry them.
      setFormError(messageOf(error, SAVE_FAILED));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>, folderId: string): Promise<void> {
    event.preventDefault();
    if (inspection === null) return;

    const built = buildRequest(fileId, folderId, month, inspection.sheets, rows);
    if ("error" in built) {
      setResult(null);
      setFormError(built.error);
      return;
    }

    await send(built.request);
  }

  if (folderState.status === "checking") {
    return <p>Loading your dashboard folder…</p>;
  }

  const { folder } = folderState;

  if (folder === null) {
    return (
      <p role="alert" className="page-error">
        {FOLDER_REQUIRED}
      </p>
    );
  }

  return (
    <div className="legacy-setup">
      <section className="section" aria-labelledby="confirm-file-heading">
        <h2 id="confirm-file-heading">Confirm this file</h2>
        <p>
          Select this same attendance file in Google Picker. Until then this app can neither
          read nor change it.
        </p>

        <GooglePicker
          mode="spreadsheet"
          label="Select this file in Google Picker"
          onSelect={(item) => confirmFile(item.id, folder.id)}
          disabled={isSaving}
        />

        {pickerError === null ? null : (
          <p role="alert" className="section-error">
            {pickerError}
          </p>
        )}

        {loadError === null ? null : (
          <p role="alert" className="section-error">
            {loadError}
          </p>
        )}

        {isConfirmed && inspection === null && loadError === null ? (
          <p>Loading the sheets in this file…</p>
        ) : null}
      </section>

      {inspection === null ? null : (
        <section className="section" aria-labelledby="map-sheets-heading">
          <h2 id="map-sheets-heading">Map every sheet to a member</h2>

          <dl className="card-facts">
            <div className="card-fact">
              <dt>File</dt>
              <dd>{inspection.file.name}</dd>
            </div>
            <div className="card-fact">
              <dt>Folder</dt>
              <dd>{inspection.folder.name}</dd>
            </div>
          </dl>

          {inspection.hasUntrustedConfig ? <p className="section-note">{UNTRUSTED_CONFIG}</p> : null}

          <form
            className="member-form"
            noValidate
            onSubmit={(event) => void handleSave(event, folder.id)}
          >
            <div className="field">
              <label htmlFor="setup-month">Month</label>
              <input
                id="setup-month"
                name="month"
                type="text"
                inputMode="numeric"
                placeholder="2026-07"
                autoComplete="off"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </div>

            <ul className="mapping-list">
              {inspection.sheets.map((sheet) => (
                <li className="mapping-row" key={sheet.sheetId}>
                  <p className="mapping-sheet">{sheet.title}</p>

                  <div className="field">
                    <label htmlFor={`name-${sheet.sheetId}`}>{`Name for ${sheet.title}`}</label>
                    <input
                      id={`name-${sheet.sheetId}`}
                      type="text"
                      autoComplete="off"
                      value={rows[sheet.sheetId]?.displayName ?? ""}
                      onChange={(event) =>
                        updateRow(sheet.sheetId, { displayName: event.target.value })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`email-${sheet.sheetId}`}>
                      {`Google Workspace email for ${sheet.title}`}
                    </label>
                    <input
                      id={`email-${sheet.sheetId}`}
                      type="email"
                      autoComplete="off"
                      value={rows[sheet.sheetId]?.email ?? ""}
                      onChange={(event) => updateRow(sheet.sheetId, { email: event.target.value })}
                    />
                  </div>
                </li>
              ))}
            </ul>

            <button type="submit" className="action action-primary" disabled={isSaving}>
              Save setup
            </button>
          </form>

          {formError === null ? null : (
            <p role="alert" className="form-error">
              {formError}
            </p>
          )}

          {result === null ? null : (
            <div className="setup-result">
              <p role="status" className="form-status">
                {result.file.complete ? COMPLETE_NOTICE : PARTIAL_NOTICE}
              </p>

              <MemberRows
                fileId={fileId}
                members={result.members.map(toSummary)}
                emptyMessage="This file has no members yet."
              />

              {result.file.complete ? (
                <a className="action action-primary" href={`/files/${fileId}/members`}>
                  Open members
                </a>
              ) : (
                <button
                  type="button"
                  className="action action-primary"
                  disabled={isSaving || lastRequest === null}
                  onClick={() => {
                    if (lastRequest !== null) void send(lastRequest);
                  }}
                >
                  Retry setup
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
