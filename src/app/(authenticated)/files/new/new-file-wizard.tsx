"use client";

import { useEffect, useReducer } from "react";
import {
  ApiErrorNotice,
  requestApi,
  toApiFailure,
  type ApiFailure,
} from "@/components/api-error-notice";
import {
  DestinationFolder,
  validateDestinationFolder,
} from "@/components/destination-folder";
import { MemberInputs, type DraftMember, type DraftMemberErrors } from "@/components/member-inputs";
import { MonthLabel } from "@/components/month-label";
import { SetupProgress } from "@/components/setup-progress";
import type { SetupState } from "@/lib/config/schema";
import {
  readFolderPreference,
  writeFolderPreference,
  type FolderPreference,
} from "@/lib/dashboard/folder-preference";
import type { MemberSummary } from "@/lib/files/member-service";
import type { CreateFileInput } from "@/lib/files/schemas";
import type { MemberSetupProgress } from "@/lib/files/setup-service";
import { ATTENDANCE_NAME_MARKER } from "@/lib/google/types";
import {
  buildEmployeeSheetTitle,
  isSheetTitleError,
  normalizeSheetTitleKey,
} from "@/lib/workbook/template";

/**
 * Create-monthly-file wizard (section 4.3).
 *
 * Three stages — file details, members, review — over one reducer, so going
 * back never loses a typed value. Nothing is sent to Google before the explicit
 * `Create file` action on the review stage: the remembered dashboard folder is
 * only a suggestion and is revalidated by the server before it can be used, and
 * every rule the API enforces (marker, month, unique emails, legal and unique
 * tab titles, non-empty roster) is also refused here so an obviously invalid
 * request never reaches Drive.
 *
 * A 207 answer is a *partial success*: Drive kept the file. The response's
 * folder becomes the remembered dashboard folder immediately, the retained
 * per-member progress is shown, and the manager continues in the resume flow.
 * The wizard deliberately offers no in-place retry, because `POST
 * /api/files/create` always creates a new file and would duplicate the one
 * Google already kept.
 */

/* -------------------------------------------------------------------------- */
/* API contract                                                                */
/* -------------------------------------------------------------------------- */

export interface CreatedFileSummary {
  id: string;
  name: string;
  /** `YYYY-MM`. */
  month: string;
  setupState: SetupState;
  /** `false` for the 207 partial-setup answer. */
  complete: boolean;
}

export interface CreateFileResponse {
  file: CreatedFileSummary;
  /** Folder as Drive revalidated it during the request. */
  folder: FolderPreference;
  members: MemberSetupProgress[];
}

export interface CreateWizardApi {
  validateFolder(folderId: string): Promise<FolderPreference>;
  create(input: CreateFileInput): Promise<CreateFileResponse>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export const createWizardApi: CreateWizardApi = {
  validateFolder: validateDestinationFolder,

  async create(input) {
    const { body } = await requestApi<CreateFileResponse>("/api/files/create", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    });

    return body;
  },
};

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

const FILE_NAME_REQUIRED = "Enter a file name.";
const FILE_NAME_MARKER = `The file name must contain ${ATTENDANCE_NAME_MARKER}.`;
const MONTH_REQUIRED = "Select the attendance month.";
const FOLDER_REQUIRED = "Select a destination folder.";
const NAME_REQUIRED = "Enter the member's name.";
const EMAIL_INVALID = "Enter a valid Google Workspace email address.";
const DUPLICATE_EMAIL = "Each member needs a different email address.";
const ROSTER_EMPTY = "Add at least one member.";
const CREATE_FAILED = "Could not create the attendance file.";
const PARTIAL_DESCRIPTION =
  "The file was created and kept in Google Drive. Resume setup to finish the remaining steps.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

type Stage = "details" | "members" | "review" | "created" | "partial";

interface DetailErrors {
  fileName?: string;
  month?: string;
  folder?: string;
}

interface WizardState {
  stage: Stage;
  fileName: string;
  month: string;
  folder: FolderPreference | null;
  folderFailure: ApiFailure | null;
  detailErrors: DetailErrors;
  members: DraftMember[];
  memberErrors: Record<string, DraftMemberErrors>;
  rosterError: string | null;
  nextMemberId: number;
  isSubmitting: boolean;
  failure: ApiFailure | null;
  result: CreateFileResponse | null;
}

type WizardAction =
  | { type: "field"; field: "fileName" | "month"; value: string }
  | { type: "folder-selected"; folder: FolderPreference }
  | { type: "folder-rejected"; failure: ApiFailure }
  | { type: "member-changed"; id: string; patch: Partial<Omit<DraftMember, "id">> }
  | { type: "member-added" }
  | { type: "member-removed"; id: string }
  | { type: "advance" }
  | { type: "back" }
  | { type: "submitting" }
  | { type: "failed"; failure: ApiFailure }
  | { type: "settled"; result: CreateFileResponse };

function draftMember(id: number): DraftMember {
  return { id: `member-${id}`, displayName: "", email: "" };
}

function createInitialState(): WizardState {
  return {
    stage: "details",
    fileName: "",
    month: "",
    folder: null,
    folderFailure: null,
    detailErrors: {},
    members: [draftMember(1)],
    memberErrors: {},
    rosterError: null,
    nextMemberId: 2,
    isSubmitting: false,
    failure: null,
    result: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function validateDetails(state: WizardState): DetailErrors {
  const fileName = state.fileName.trim();
  const errors: DetailErrors = {};

  if (fileName === "") {
    errors.fileName = FILE_NAME_REQUIRED;
  } else if (!fileName.includes(ATTENDANCE_NAME_MARKER)) {
    errors.fileName = FILE_NAME_MARKER;
  }

  if (!MONTH_PATTERN.test(state.month.trim())) {
    errors.month = MONTH_REQUIRED;
  }

  if (state.folder === null) {
    errors.folder = FOLDER_REQUIRED;
  }

  return errors;
}

/** The tab title of a member is its trimmed display name (section 4.3). */
function validateTitle(displayName: string, seenTitles: Set<string>): string | undefined {
  try {
    const title = buildEmployeeSheetTitle(displayName);
    const key = normalizeSheetTitleKey(title);

    if (seenTitles.has(key)) {
      return `Employee sheet title "${title}" is already used by another member.`;
    }

    seenTitles.add(key);
    return undefined;
  } catch (error) {
    return isSheetTitleError(error) ? error.message : NAME_REQUIRED;
  }
}

interface RosterValidation {
  errors: Record<string, DraftMemberErrors>;
  rosterError: string | null;
}

function validateMembers(members: readonly DraftMember[]): RosterValidation {
  if (members.length === 0) return { errors: {}, rosterError: ROSTER_EMPTY };

  const errors: Record<string, DraftMemberErrors> = {};
  const seenEmails = new Set<string>();
  const seenTitles = new Set<string>();

  for (const member of members) {
    const displayName = member.displayName.trim();
    const email = member.email.trim().toLowerCase();

    const displayNameError =
      displayName === "" ? NAME_REQUIRED : validateTitle(displayName, seenTitles);

    let emailError: string | undefined;
    if (!EMAIL_PATTERN.test(email)) {
      emailError = EMAIL_INVALID;
    } else if (seenEmails.has(email)) {
      emailError = DUPLICATE_EMAIL;
    } else {
      seenEmails.add(email);
    }

    if (displayNameError !== undefined || emailError !== undefined) {
      errors[member.id] = {
        ...(displayNameError === undefined ? {} : { displayName: displayNameError }),
        ...(emailError === undefined ? {} : { email: emailError }),
      };
    }
  }

  return { errors, rosterError: null };
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

function advance(state: WizardState): WizardState {
  if (state.stage === "details") {
    const detailErrors = validateDetails(state);
    const isValid = Object.keys(detailErrors).length === 0;

    return { ...state, detailErrors, stage: isValid ? "members" : "details" };
  }

  if (state.stage === "members") {
    const { errors, rosterError } = validateMembers(state.members);
    const isValid = rosterError === null && Object.keys(errors).length === 0;

    return { ...state, memberErrors: errors, rosterError, stage: isValid ? "review" : "members" };
  }

  return state;
}

function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "field":
      return { ...state, [action.field]: action.value };

    case "folder-selected":
      return { ...state, folder: action.folder, folderFailure: null };

    case "folder-rejected":
      return { ...state, folder: null, folderFailure: action.failure };

    case "member-changed":
      return {
        ...state,
        members: state.members.map((member) =>
          member.id === action.id ? { ...member, ...action.patch } : member,
        ),
      };

    case "member-added":
      return {
        ...state,
        members: [...state.members, draftMember(state.nextMemberId)],
        nextMemberId: state.nextMemberId + 1,
      };

    case "member-removed":
      return { ...state, members: state.members.filter((member) => member.id !== action.id) };

    case "advance":
      return advance(state);

    case "back":
      return {
        ...state,
        stage: state.stage === "review" ? "members" : "details",
        failure: null,
      };

    case "submitting":
      return { ...state, isSubmitting: true, failure: null };

    case "failed":
      return { ...state, isSubmitting: false, failure: action.failure };

    case "settled":
      return {
        ...state,
        isSubmitting: false,
        failure: null,
        result: action.result,
        stage: action.result.file.complete ? "created" : "partial",
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

function toCreateInput(state: WizardState, folder: FolderPreference): CreateFileInput {
  return {
    fileName: state.fileName.trim(),
    month: state.month.trim(),
    destinationFolder: { id: folder.id, name: folder.name },
    members: state.members.map((member) => ({
      displayName: member.displayName.trim(),
      email: member.email.trim().toLowerCase(),
    })),
  };
}

/** The retained progress of a partial setup, as the shared roster renders it. */
function toMemberSummaries(members: readonly MemberSetupProgress[]): MemberSummary[] {
  return members.map((member) => ({
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    setupStatus: member.setupStatus,
    invitationSent: member.permissionId !== null,
  }));
}

function defaultNavigate(href: string): void {
  window.location.assign(href);
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface NewFileWizardProps {
  /** Normalized signed-in email; scopes the remembered folder only. */
  email: string;
  /** Injected in tests; the browser uses the fetch client by default. */
  api?: CreateWizardApi;
  navigate?: (href: string) => void;
}

export function NewFileWizard({
  email,
  api = createWizardApi,
  navigate = defaultNavigate,
}: NewFileWizardProps) {
  const [state, dispatch] = useReducer(reduce, undefined, createInitialState);

  /**
   * The remembered folder lives in browser storage, so it can only be read
   * after mount, and it is never authoritative: Drive revalidates it before it
   * can be used as a destination.
   */
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

  async function create(): Promise<void> {
    if (state.folder === null || state.isSubmitting) return;

    const input = toCreateInput(state, state.folder);
    dispatch({ type: "submitting" });

    try {
      const result = await api.create(input);

      // Drive kept the file either way, so its folder becomes the active
      // dashboard folder before anything else (section 9.2).
      writeFolderPreference(email, result.folder);
      dispatch({ type: "settled", result });

      if (result.file.complete) {
        navigate(`/files/${result.file.id}/members`);
      }
    } catch (error) {
      dispatch({ type: "failed", failure: toApiFailure(error) });
    }
  }

  if (state.stage === "created" && state.result !== null) {
    return (
      <p role="status" className="form-status">
        {`Created ${state.result.file.name}. Opening it now…`}
      </p>
    );
  }

  if (state.stage === "partial" && state.result !== null) {
    return (
      <SetupProgress
        fileId={state.result.file.id}
        fileName={state.result.file.name}
        folderName={state.result.folder.name}
        description={PARTIAL_DESCRIPTION}
        members={toMemberSummaries(state.result.members)}
      />
    );
  }

  if (state.stage === "details") {
    return (
      <section className="section" aria-labelledby="details-heading">
        <h2 id="details-heading">File details</h2>

        <div className="field">
          <label htmlFor="file-name">File name</label>
          <input
            id="file-name"
            type="text"
            autoComplete="off"
            value={state.fileName}
            aria-invalid={state.detailErrors.fileName !== undefined}
            aria-describedby="file-name-hint"
            onChange={(event) =>
              dispatch({ type: "field", field: "fileName", value: event.target.value })
            }
          />
          <p id="file-name-hint" className="field-hint">
            {`Include ${ATTENDANCE_NAME_MARKER} so the file stays discoverable in Drive.`}
          </p>
          {state.detailErrors.fileName === undefined ? null : (
            <p role="alert" className="field-error">
              {state.detailErrors.fileName}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="attendance-month">Month</label>
          <input
            id="attendance-month"
            type="month"
            value={state.month}
            aria-invalid={state.detailErrors.month !== undefined}
            onChange={(event) =>
              dispatch({ type: "field", field: "month", value: event.target.value })
            }
          />
          {state.detailErrors.month === undefined ? null : (
            <p role="alert" className="field-error">
              {state.detailErrors.month}
            </p>
          )}
        </div>

        <DestinationFolder
          folder={state.folder}
          error={state.detailErrors.folder}
          failure={state.folderFailure}
          onSelect={selectFolder}
        />

        <div className="card-actions">
          <button
            type="button"
            className="action action-primary"
            onClick={() => dispatch({ type: "advance" })}
          >
            Continue to members
          </button>
        </div>
      </section>
    );
  }

  if (state.stage === "members") {
    return (
      <section className="section" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>

        <MemberInputs
          members={state.members}
          errors={state.memberErrors}
          onChange={(id, patch) => dispatch({ type: "member-changed", id, patch })}
          onAdd={() => dispatch({ type: "member-added" })}
          onRemove={(id) => dispatch({ type: "member-removed", id })}
        />

        {state.rosterError === null ? null : (
          <p role="alert" className="field-error">
            {state.rosterError}
          </p>
        )}

        <div className="card-actions">
          <button type="button" className="action" onClick={() => dispatch({ type: "back" })}>
            Back to file details
          </button>
          <button
            type="button"
            className="action action-primary"
            onClick={() => dispatch({ type: "advance" })}
          >
            Review
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="section" aria-labelledby="review-heading">
      <h2 id="review-heading">Review and create</h2>

      <dl className="card-facts">
        <div className="card-fact">
          <dt>File name</dt>
          <dd>{state.fileName.trim()}</dd>
        </div>
        <div className="card-fact">
          <dt>Month</dt>
          <dd>
            <MonthLabel month={state.month} />
          </dd>
        </div>
        <div className="card-fact">
          <dt>Destination folder</dt>
          <dd>{state.folder?.name ?? ""}</dd>
        </div>
      </dl>

      <ul className="member-list" aria-label="Members to create">
        {state.members.map((member) => (
          <li className="member-row" key={member.id} aria-label={member.displayName.trim()}>
            <p className="member-name">{member.displayName.trim()}</p>
            <p className="member-email">{member.email.trim().toLowerCase()}</p>
          </li>
        ))}
      </ul>

      <ApiErrorNotice failure={state.failure} fallbackMessage={CREATE_FAILED} />

      <div className="card-actions">
        <button
          type="button"
          className="action"
          disabled={state.isSubmitting}
          onClick={() => dispatch({ type: "back" })}
        >
          Back to members
        </button>
        <button
          type="button"
          className="action action-primary"
          disabled={state.isSubmitting}
          onClick={() => void create()}
        >
          {state.isSubmitting ? "Creating file…" : "Create file"}
        </button>
      </div>
    </section>
  );
}
