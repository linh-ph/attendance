"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MemberRows } from "@/components/member-rows";
import { LoadingGhosts } from "@/components/loading-ghosts";
import type { MemberSummary } from "@/lib/files/member-service";

/**
 * Manage members for one attendance file.
 *
 * The roster and every setup status come from the protected configuration, so
 * the browser never decides who is a member. Adding confirms in place: the new
 * row and a confirmation appear without leaving the page, and a member whose
 * tab exists but whose invitation failed keeps its sheet and offers
 * `Retry invitation` for that one email. No removal action exists anywhere.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NAME_REQUIRED = "Enter the member's name.";
const EMAIL_INVALID = "Enter a valid Google Workspace email address.";
const LOAD_FAILED = "Could not load the members of this file.";
const ADD_FAILED = "Could not add this member.";
const RETRY_FAILED = "Could not send the invitation.";

export interface MemberApiError extends Error {
  /** Machine-readable code from the API envelope, when it sent one. */
  code?: string;
}

export interface MemberMutationResponse {
  member: MemberSummary;
  invitationFailed: boolean;
}

export interface MemberListResponse {
  fileId: string;
  month: string;
  members: MemberSummary[];
}

export interface MemberApiClient {
  list(fileId: string): Promise<MemberListResponse>;
  add(
    fileId: string,
    input: { displayName: string; email: string },
  ): Promise<MemberMutationResponse>;
  retryInvitation(fileId: string, email: string): Promise<MemberMutationResponse>;
}

/* -------------------------------------------------------------------------- */
/* Default browser client                                                      */
/* -------------------------------------------------------------------------- */

function membersUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/members`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  // 207 means the member was added but the invitation failed; the body still
  // carries the retained IDs, so it is a success for the caller.
  if (!response.ok) {
    const envelope = (body ?? {}) as { error?: string; code?: string };
    const error = new Error(envelope.error ?? ADD_FAILED) as MemberApiError;
    error.code = envelope.code;
    throw error;
  }

  return body as T;
}

function jsonRequest(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export const memberApiClient: MemberApiClient = {
  list: (fileId) => requestJson<MemberListResponse>(membersUrl(fileId)),
  add: (fileId, input) =>
    requestJson<MemberMutationResponse>(membersUrl(fileId), jsonRequest("POST", input)),
  retryInvitation: (fileId, email) =>
    requestJson<MemberMutationResponse>(membersUrl(fileId), jsonRequest("PATCH", { email })),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface FieldErrors {
  displayName?: string;
  email?: string;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** Keeps one row per normalized email: a retried member replaces its own row. */
function upsertMember(members: MemberSummary[], member: MemberSummary): MemberSummary[] {
  const index = members.findIndex((candidate) => candidate.email === member.email);
  return index === -1
    ? [...members, member]
    : members.map((candidate, position) => (position === index ? member : candidate));
}

function addedNotice(result: MemberMutationResponse): string {
  return result.invitationFailed
    ? `Added ${result.member.displayName}, but the Google Drive invitation failed. Retry the invitation.`
    : `Added ${result.member.displayName}. Their sheet is ready.`;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface MemberFormProps {
  fileId: string;
  /** Injected in tests; the browser uses the fetch client by default. */
  api?: MemberApiClient;
}

export function MemberForm({ fileId, api = memberApiClient }: MemberFormProps) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [retryingEmail, setRetryingEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .list(fileId)
      .then((result) => {
        if (!cancelled) setMembers(result.members);
      })
      .catch(() => {
        if (!cancelled) setLoadError(LOAD_FAILED);
      });

    return () => {
      cancelled = true;
    };
  }, [api, fileId]);

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const trimmedName = displayName.trim();
    const normalizedEmail = email.trim().toLowerCase();

    const errors: FieldErrors = {
      ...(trimmedName === "" ? { displayName: NAME_REQUIRED } : {}),
      ...(EMAIL_PATTERN.test(normalizedEmail) ? {} : { email: EMAIL_INVALID }),
    };

    setFieldErrors(errors);
    setActionError(null);

    // Rejected in the browser, so an obviously invalid member never reaches
    // Google. The server validates the same request again.
    if (errors.displayName !== undefined || errors.email !== undefined) {
      setNotice(null);
      return;
    }

    setIsAdding(true);
    try {
      const result = await api.add(fileId, {
        displayName: trimmedName,
        email: normalizedEmail,
      });

      setMembers((current) => upsertMember(current ?? [], result.member));
      setDisplayName("");
      setEmail("");
      setNotice(addedNotice(result));
    } catch (error) {
      // The typed values stay on the page so the manager can correct them.
      setNotice(null);
      setActionError(messageOf(error, ADD_FAILED));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRetry(memberEmail: string): Promise<void> {
    setRetryingEmail(memberEmail);
    setActionError(null);

    try {
      const result = await api.retryInvitation(fileId, memberEmail);

      setMembers((current) => upsertMember(current ?? [], result.member));
      setNotice(
        result.invitationFailed
          ? `The Google Drive invitation to ${result.member.email} failed again.`
          : `Invitation sent to ${result.member.email}.`,
      );
    } catch (error) {
      setNotice(null);
      setActionError(messageOf(error, RETRY_FAILED));
    } finally {
      setRetryingEmail(null);
    }
  }

  return (
    <div className="members">
      <section className="section" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>

        {loadError !== null ? (
          <p role="alert" className="section-error">
            {loadError}
          </p>
        ) : null}

        {members === null && loadError === null ? <LoadingGhosts label="Loading members…" /> : null}

        {members === null ? null : (
          <MemberRows
            fileId={fileId}
            members={members}
            onRetryInvitation={(memberEmail) => void handleRetry(memberEmail)}
            retryingEmail={retryingEmail}
            emptyMessage="This file has no members yet."
          />
        )}
      </section>

      <section className="section" aria-labelledby="add-member-heading">
        <h2 id="add-member-heading">Add member</h2>

        <form id="add-member" className="member-form" noValidate onSubmit={(event) => void handleAdd(event)}>
          <div className="field">
            <label htmlFor="member-name">Name</label>
            <input
              id="member-name"
              name="displayName"
              type="text"
              autoComplete="off"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-invalid={fieldErrors.displayName !== undefined}
            />
            {fieldErrors.displayName === undefined ? null : (
              <p role="alert" className="field-error">
                {fieldErrors.displayName}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="member-email">Google Workspace email</label>
            <input
              id="member-email"
              name="email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={fieldErrors.email !== undefined}
            />
            {fieldErrors.email === undefined ? null : (
              <p role="alert" className="field-error">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <button type="submit" className="action action-primary" disabled={isAdding}>
            Add member
          </button>
        </form>

        {actionError === null ? null : (
          <p role="alert" className="form-error">
            {actionError}
          </p>
        )}

        {notice === null ? null : (
          <p role="status" className="form-status">
            {notice}
          </p>
        )}
      </section>
    </div>
  );
}
