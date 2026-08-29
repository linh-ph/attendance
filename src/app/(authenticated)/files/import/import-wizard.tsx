"use client";

import { useEffect, useReducer, type ChangeEvent } from "react";
import {
  ApiErrorNotice,
  requestApi,
  toApiFailure,
  type ApiFailure,
} from "@/components/api-error-notice";
import { DestinationFolder, validateDestinationFolder } from "@/components/destination-folder";
import { formatMonthLabel } from "@/components/month-label";
import { SetupProgress } from "@/components/setup-progress";
import type { SetupState } from "@/lib/config/schema";
import {
  readFolderPreference,
  writeFolderPreference,
  type FolderPreference,
} from "@/lib/dashboard/folder-preference";
import type { MemberSetupStatus, MemberSummary } from "@/lib/files/member-service";
import { ATTENDANCE_NAME_MARKER } from "@/lib/google/types";

/**
 * Import-an-`.xlsx`-workbook wizard (section 2.4).
 *
 * The workbook is inspected first and nothing in Google is touched by that
 * step: the manager sees every recognized sheet, confirms the output name,
 * month, and destination folder, and assigns exactly one unique email per
 * detected sheet before the file is uploaded and converted on Save.
 *
 * Two rules the sheet contract depends on are visible here. A sheet title is
 * fixed by the workbook and is never editable, because the stored mapping must
 * address a tab the converted file really has. And the month is never derived
 * from the upload's file name: it is suggested from the inspected date rows
 * when every sheet agrees, and the server revalidates every sheet against the
 * confirmed value.
 *
 * The selected `File` is held in component memory only — never in browser
 * storage — so Save and a later retry resubmit the very same bytes. A 207
 * answer means Drive kept the converted file: its folder becomes the active
 * dashboard folder, the retained per-member progress is shown, and `Retry
 * setup` resends with the resume hint so setup continues on that same file
 * instead of converting a second one.
 */

/* -------------------------------------------------------------------------- */
/* API contract                                                                */
/* -------------------------------------------------------------------------- */

export interface InspectedSheet {
  title: string;
  rowCount: number;
  /** `YYYY-MM`, read from the sheet's own date rows. */
  month: string;
}

export interface WorkbookInspectionResult {
  sheets: InspectedSheet[];
}

export interface SheetMapping {
  sheetTitle: string;
  email: string;
}

export interface ImportSaveInput {
  file: File;
  fileName: string;
  month: string;
  destinationFolder: FolderPreference;
  mappings: SheetMapping[];
  /** Continues setup on an already-converted file instead of converting again. */
  resumeFileId?: string;
}

export interface ImportSaveResponse {
  /** `false` for the 207 partial-setup answer. */
  complete: boolean;
  fileId: string;
  folder: FolderPreference;
  setupState: SetupState;
  retryable: boolean;
  members: Array<{ email: string; setupStatus: MemberSetupStatus }>;
}

export interface ImportWizardApi {
  validateFolder(folderId: string): Promise<FolderPreference>;
  inspect(file: File): Promise<WorkbookInspectionResult>;
  save(input: ImportSaveInput): Promise<ImportSaveResponse>;
}

/**
 * Multipart field names of the import routes. They are repeated here rather
 * than imported, because the server module that declares them also pulls in the
 * workbook parser, which has no business in a browser bundle.
 */
const UPLOAD_FIELD = "file";
const RESUME_FIELD = "resumeFileId";

export const importWizardApi: ImportWizardApi = {
  validateFolder: validateDestinationFolder,

  async inspect(file) {
    const form = new FormData();
    form.append(UPLOAD_FIELD, file);

    const { body } = await requestApi<WorkbookInspectionResult>("/api/files/import/inspect", {
      method: "POST",
      body: form,
    });

    return body;
  },

  async save(input) {
    const form = new FormData();
    form.append(UPLOAD_FIELD, input.file);
    form.append("fileName", input.fileName);
    form.append("month", input.month);
    form.append("destinationFolder", JSON.stringify(input.destinationFolder));
    form.append("mappings", JSON.stringify(input.mappings));

    if (input.resumeFileId !== undefined) {
      form.append(RESUME_FIELD, input.resumeFileId);
    }

    const { status, body } = await requestApi<Omit<ImportSaveResponse, "complete">>(
      "/api/files/import",
      { method: "POST", body: form },
    );

    // 201 is a finished setup; 207 keeps the converted file for a resume.
    return { ...body, complete: status === 201 };
  },
};

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

const FILE_NAME_REQUIRED = "Enter an output file name.";
const FILE_NAME_MARKER = `The file name must contain ${ATTENDANCE_NAME_MARKER}.`;
const MONTH_REQUIRED = "Select the attendance month.";
const FOLDER_REQUIRED = "Select a destination folder.";
const EMAIL_INVALID = "Enter a valid Google Workspace email address.";
const DUPLICATE_EMAIL = "Each sheet needs a different email address.";
const INSPECT_FAILED = "Could not read this workbook.";
const IMPORT_FAILED = "Could not import the attendance file.";
const PARTIAL_DESCRIPTION =
  "The file was converted and kept in Google Drive. Resume setup to finish the remaining steps.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

type Stage = "upload" | "confirm" | "created" | "partial";

interface FieldErrors {
  fileName?: string;
  month?: string;
  folder?: string;
}

interface ImportState {
  stage: Stage;
  /** Kept in memory only, so Save and Retry resubmit the same bytes. */
  file: File | null;
  isInspecting: boolean;
  sheets: InspectedSheet[];
  inspectFailure: ApiFailure | null;
  fileName: string;
  month: string;
  folder: FolderPreference | null;
  folderFailure: ApiFailure | null;
  /** Confirmed email per workbook sheet title. */
  emails: Record<string, string>;
  fieldErrors: FieldErrors;
  emailErrors: Record<string, string>;
  isSaving: boolean;
  failure: ApiFailure | null;
  result: ImportSaveResponse | null;
  /** Mappings of the request that produced `result`, for the retained roster. */
  submitted: SheetMapping[];
}

type ImportAction =
  | { type: "file-selected"; file: File }
  | { type: "inspected"; sheets: InspectedSheet[] }
  | { type: "inspect-failed"; failure: ApiFailure }
  | { type: "field"; field: "fileName" | "month"; value: string }
  | { type: "email"; sheetTitle: string; value: string }
  | { type: "folder-selected"; folder: FolderPreference }
  | { type: "folder-rejected"; failure: ApiFailure }
  | { type: "rejected"; fieldErrors: FieldErrors; emailErrors: Record<string, string> }
  | { type: "saving" }
  | { type: "failed"; failure: ApiFailure }
  | { type: "settled"; result: ImportSaveResponse; mappings: SheetMapping[] };

function createInitialState(): ImportState {
  return {
    stage: "upload",
    file: null,
    isInspecting: false,
    sheets: [],
    inspectFailure: null,
    fileName: "",
    month: "",
    folder: null,
    folderFailure: null,
    emails: {},
    fieldErrors: {},
    emailErrors: {},
    isSaving: false,
    failure: null,
    result: null,
    submitted: [],
  };
}

/** The upload's base name is a suggestion the manager may replace. */
function suggestFileName(file: File): string {
  return file.name.replace(/\.xlsx$/iu, "");
}

/**
 * Suggests the month from the inspected date rows, and only when every sheet
 * agrees. The upload's file name never contributes: a workbook called
 * `202601勤怠管理表.xlsx` whose rows are July 2026 is a July file.
 */
function suggestMonth(sheets: readonly InspectedSheet[]): string {
  if (sheets.length === 0) return "";

  const [first] = sheets;
  return sheets.every((sheet) => sheet.month === first.month) ? first.month : "";
}

function reduce(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case "file-selected":
      return {
        ...state,
        stage: "upload",
        file: action.file,
        isInspecting: true,
        sheets: [],
        emails: {},
        emailErrors: {},
        inspectFailure: null,
        failure: null,
        fileName: suggestFileName(action.file),
      };

    case "inspected":
      return {
        ...state,
        stage: "confirm",
        isInspecting: false,
        sheets: action.sheets,
        month: suggestMonth(action.sheets),
      };

    case "inspect-failed":
      return { ...state, stage: "upload", isInspecting: false, inspectFailure: action.failure };

    case "field":
      return { ...state, [action.field]: action.value };

    case "email":
      return { ...state, emails: { ...state.emails, [action.sheetTitle]: action.value } };

    case "folder-selected":
      return { ...state, folder: action.folder, folderFailure: null };

    case "folder-rejected":
      return { ...state, folder: null, folderFailure: action.failure };

    case "rejected":
      return { ...state, fieldErrors: action.fieldErrors, emailErrors: action.emailErrors };

    case "saving":
      return { ...state, isSaving: true, failure: null, fieldErrors: {}, emailErrors: {} };

    case "failed":
      return { ...state, isSaving: false, failure: action.failure };

    case "settled":
      return {
        ...state,
        isSaving: false,
        failure: null,
        result: action.result,
        submitted: action.mappings,
        stage: action.result.complete ? "created" : "partial",
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

interface ValidatedRequest {
  fieldErrors: FieldErrors;
  emailErrors: Record<string, string>;
  mappings: SheetMapping[];
}

function validate(state: ImportState): ValidatedRequest {
  const fileName = state.fileName.trim();
  const fieldErrors: FieldErrors = {};

  if (fileName === "") {
    fieldErrors.fileName = FILE_NAME_REQUIRED;
  } else if (!fileName.includes(ATTENDANCE_NAME_MARKER)) {
    fieldErrors.fileName = FILE_NAME_MARKER;
  }

  if (!MONTH_PATTERN.test(state.month.trim())) {
    fieldErrors.month = MONTH_REQUIRED;
  }

  if (state.folder === null) {
    fieldErrors.folder = FOLDER_REQUIRED;
  }

  const emailErrors: Record<string, string> = {};
  const seen = new Set<string>();
  const mappings: SheetMapping[] = [];

  // Every recognized sheet becomes a managed member sheet, so each one needs
  // its own address before anything is uploaded.
  for (const sheet of state.sheets) {
    const email = (state.emails[sheet.title] ?? "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      emailErrors[sheet.title] = EMAIL_INVALID;
      continue;
    }

    if (seen.has(email)) {
      emailErrors[sheet.title] = DUPLICATE_EMAIL;
      continue;
    }

    seen.add(email);
    mappings.push({ sheetTitle: sheet.title, email });
  }

  return { fieldErrors, emailErrors, mappings };
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                        */
/* -------------------------------------------------------------------------- */

function sheetDetail(sheet: InspectedSheet): string {
  const rows = `${sheet.rowCount} rows`;
  const month = formatMonthLabel(sheet.month);

  return month === null ? rows : `${rows} · ${month}`;
}

/**
 * The import response reports one status per email. The sheet the manager
 * mapped it to is the name they recognize, so the retained roster is labelled
 * by workbook sheet title.
 */
function toMemberSummaries(
  members: ImportSaveResponse["members"],
  mappings: readonly SheetMapping[],
): MemberSummary[] {
  const titleByEmail = new Map(mappings.map((mapping) => [mapping.email, mapping.sheetTitle]));

  return members.map((member) => {
    const sheetTitle = titleByEmail.get(member.email) ?? null;

    return {
      displayName: sheetTitle ?? member.email,
      email: member.email,
      sheetId: null,
      sheetTitle,
      setupStatus: member.setupStatus,
      invitationSent: member.setupStatus === "ready",
    };
  });
}

function defaultNavigate(href: string): void {
  window.location.assign(href);
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImportWizardProps {
  /** Normalized signed-in email; scopes the remembered folder only. */
  email: string;
  /** Injected in tests; the browser uses the fetch client by default. */
  api?: ImportWizardApi;
  navigate?: (href: string) => void;
}

export function ImportWizard({
  email,
  api = importWizardApi,
  navigate = defaultNavigate,
}: ImportWizardProps) {
  const [state, dispatch] = useReducer(reduce, undefined, createInitialState);

  /** The remembered folder is a convenience; Drive revalidates it on mount. */
  useEffect(() => {
    const remembered = readFolderPreference(email);
    if (remembered === null) return;

    let cancelled = false;

    void api.validateFolder(remembered.id).then(
      (folder) => {
        if (!cancelled) dispatch({ type: "folder-selected", folder });
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ type: "folder-rejected", failure: toApiFailure(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [api, email]);

  function selectFolder(picked: FolderPreference): void {
    void api.validateFolder(picked.id).then(
      (folder) => dispatch({ type: "folder-selected", folder }),
      (error: unknown) => dispatch({ type: "folder-rejected", failure: toApiFailure(error) }),
    );
  }

  /** Inspection is local to the server's parser; it mutates nothing in Google. */
  async function inspect(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    dispatch({ type: "file-selected", file });

    try {
      const inspection = await api.inspect(file);
      dispatch({ type: "inspected", sheets: inspection.sheets });
    } catch (error) {
      dispatch({ type: "inspect-failed", failure: toApiFailure(error) });
    }
  }

  async function send(input: ImportSaveInput): Promise<void> {
    dispatch({ type: "saving" });

    try {
      const result = await api.save(input);

      // Drive kept the converted file either way, so its folder becomes the
      // active dashboard folder before anything else (section 9.2).
      writeFolderPreference(email, result.folder);
      dispatch({ type: "settled", result, mappings: input.mappings });

      if (result.complete) {
        navigate(`/files/${result.fileId}/members`);
      }
    } catch (error) {
      dispatch({ type: "failed", failure: toApiFailure(error) });
    }
  }

  async function save(): Promise<void> {
    if (state.file === null || state.isSaving) return;

    const { fieldErrors, emailErrors, mappings } = validate(state);

    // Refused here as well as by the API, so an obviously invalid workbook is
    // never uploaded and converted.
    if (
      state.folder === null ||
      Object.keys(fieldErrors).length > 0 ||
      Object.keys(emailErrors).length > 0
    ) {
      dispatch({ type: "rejected", fieldErrors, emailErrors });
      return;
    }

    await send({
      file: state.file,
      fileName: state.fileName.trim(),
      month: state.month.trim(),
      destinationFolder: { id: state.folder.id, name: state.folder.name },
      mappings,
    });
  }

  /** Resumes the retained conversion rather than uploading a second file. */
  async function retry(): Promise<void> {
    if (state.file === null || state.result === null || state.folder === null) return;

    await send({
      file: state.file,
      fileName: state.fileName.trim(),
      month: state.month.trim(),
      destinationFolder: { id: state.folder.id, name: state.folder.name },
      mappings: state.submitted,
      resumeFileId: state.result.fileId,
    });
  }

  if (state.stage === "created" && state.result !== null) {
    return (
      <p role="status" className="form-status">
        {`Imported ${state.fileName.trim()}. Opening it now…`}
      </p>
    );
  }

  if (state.stage === "partial" && state.result !== null) {
    return (
      <SetupProgress
        fileId={state.result.fileId}
        fileName={state.fileName.trim()}
        folderName={state.result.folder.name}
        description={PARTIAL_DESCRIPTION}
        members={toMemberSummaries(state.result.members, state.submitted)}
        onRetry={state.result.retryable ? () => void retry() : undefined}
        isRetrying={state.isSaving}
      />
    );
  }

  return (
    <div className="import-wizard">
      <section className="section step" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Workbook</h2>

        <div className="field">
          <label htmlFor="workbook">Excel workbook (.xlsx)</label>
          <input
            id="workbook"
            type="file"
            accept=".xlsx"
            disabled={state.isInspecting || state.isSaving}
            onChange={(event) => void inspect(event)}
          />
          <p className="field-hint">The workbook must be 20 MB or smaller.</p>
        </div>

        {state.isInspecting ? <p role="status">Reading the workbook…</p> : null}

        <ApiErrorNotice failure={state.inspectFailure} fallbackMessage={INSPECT_FAILED} />
      </section>

      {state.stage === "confirm" ? (
        <>
          <section className="section step" aria-labelledby="sheets-heading">
            <h2 id="sheets-heading">Recognized sheets</h2>

            <ul className="card-list" aria-label="Recognized sheets">
              {state.sheets.map((sheet) => (
                <li className="card" key={sheet.title} aria-label={sheet.title}>
                  <p className="card-title">{sheet.title}</p>
                  <p className="card-detail">{sheetDetail(sheet)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="section step" aria-labelledby="output-heading">
            <h2 id="output-heading">Output file</h2>

            <div className="field">
              <label htmlFor="output-name">Output file name</label>
              <input
                id="output-name"
                type="text"
                autoComplete="off"
                value={state.fileName}
                aria-invalid={state.fieldErrors.fileName !== undefined}
                aria-describedby="output-name-hint"
                onChange={(event) =>
                  dispatch({ type: "field", field: "fileName", value: event.target.value })
                }
              />
              <p id="output-name-hint" className="field-hint">
                {`Include ${ATTENDANCE_NAME_MARKER} so the file stays discoverable in Drive.`}
              </p>
              {state.fieldErrors.fileName === undefined ? null : (
                <p role="alert" className="field-error">
                  {state.fieldErrors.fileName}
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="import-month">Month</label>
              <input
                id="import-month"
                type="month"
                value={state.month}
                aria-invalid={state.fieldErrors.month !== undefined}
                onChange={(event) =>
                  dispatch({ type: "field", field: "month", value: event.target.value })
                }
              />
              {state.fieldErrors.month === undefined ? null : (
                <p role="alert" className="field-error">
                  {state.fieldErrors.month}
                </p>
              )}
            </div>

            <DestinationFolder
              folder={state.folder}
              error={state.fieldErrors.folder}
              failure={state.folderFailure}
              onSelect={selectFolder}
              disabled={state.isSaving}
            />
          </section>

          <section className="section step" aria-labelledby="mappings-heading">
            <h2 id="mappings-heading">Sheet owners</h2>

            <ul className="member-input-list">
              {state.sheets.map((sheet) => {
                const inputId = `sheet-email-${sheet.title}`;
                const error = state.emailErrors[sheet.title];

                return (
                  <li className="member-input-row" key={sheet.title} aria-label={sheet.title}>
                    <div className="field">
                      <label htmlFor={inputId}>{`Email for ${sheet.title}`}</label>
                      <input
                        id={inputId}
                        type="email"
                        autoComplete="off"
                        value={state.emails[sheet.title] ?? ""}
                        disabled={state.isSaving}
                        aria-invalid={error !== undefined}
                        aria-describedby={error === undefined ? undefined : `${inputId}-error`}
                        onChange={(event) =>
                          dispatch({
                            type: "email",
                            sheetTitle: sheet.title,
                            value: event.target.value,
                          })
                        }
                      />
                      {error === undefined ? null : (
                        <p id={`${inputId}-error`} role="alert" className="field-error">
                          {error}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <ApiErrorNotice failure={state.failure} fallbackMessage={IMPORT_FAILED} />

            <div className="card-actions">
              <button
                type="button"
                className="action action-primary"
                disabled={state.isSaving}
                onClick={() => void save()}
              >
                {state.isSaving ? "Saving to Google Drive…" : "Save to Google Drive"}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
