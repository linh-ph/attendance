/**
 * One API-failure contract, and one error surface, for the whole application.
 *
 * ## The envelope
 *
 * Every route answers a failure with the same JSON envelope (`error`, and
 * sometimes `code` and `sheetTitle`), so both the parsing of that envelope and
 * its presentation live here rather than being re-invented per screen.
 *
 * Two rules decide what a person reads:
 *
 * 1. A stable machine code always wins, because the English copy for a code is
 *    owned by this application.
 * 2. A server message is rendered only for a request the person can act on
 *    (status below 500). A Google boundary failure answers 5xx, so its body is
 *    never rendered and the caller's own fallback sentence is shown instead —
 *    a provider message never reaches the screen through this path.
 *
 * ## The surface
 *
 * `ErrorNotice` owns the recovery grammar — Retry, Re-authenticate, Resume,
 * Reload — and the optional collapsed `Technical details` disclosure. It is the
 * only place in the browser that renders a provider diagnostic, and it renders
 * one only through `toSafeDiagnostic`, which narrows whatever arrived to the
 * six allowlisted fields and drops anything it cannot vouch for.
 *
 * Debug disclosure is gated **server-side** on `APP_DEBUG_ERRORS=1`: a route
 * attaches the `debug` envelope only when the switch is on, so the presence of
 * the envelope *is* the flag. There is no second client-side switch to get
 * wrong, and with the flag off the disclosure is absent rather than empty.
 *
 * Nothing here is ever written to browser storage — spec §8.3: diagnostics are
 * never persisted.
 */

import type { ReactNode } from "react";
import {
  SAFE_DIAGNOSTIC_FIELDS,
  SAFE_DIAGNOSTIC_LABELS,
  toSafeDiagnostic,
  type SafeDiagnostic,
} from "./sync-status/safe-diagnostic";

export interface ApiFailure {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  /** Stable machine code from the envelope, when the route sends one. */
  code?: string;
  /** Server-supplied English message; only rendered for actionable statuses. */
  message?: string;
  /** Workbook check failures name the sheet they rejected. */
  sheetTitle?: string | null;
}

export const SESSION_EXPIRED_MESSAGE =
  "Your Google session expired. Sign in again to continue.";

const UNAUTHENTICATED_STATUSES = [401, 403];

/** English copy this application owns, keyed by the stable API error code. */
const CODE_MESSAGES: Record<string, string> = {
  "duplicate-member-email": "Each member must have a different email address.",
  "sheet-mapping-mismatch":
    "The sheet mappings no longer match the workbook. Upload the workbook again.",
  "resume-unavailable": "This file can no longer be resumed. Start again.",
  "member-sheet-missing": "A member sheet is missing from this file. Resume setup to repair it.",
  "setup-incomplete": "Setup did not finish. Resume setup to complete the remaining steps.",
  "invalid-import-request": "Check the output file name, month, folder, and sheet mappings.",
};

export class ApiRequestError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.failure = failure;
  }
}

function isApiFailure(value: unknown): value is ApiFailure {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

/**
 * Reads the failure carried by a rejected request. Anything that is not a
 * recognizable envelope becomes status `0`, which renders the caller's
 * fallback sentence.
 */
export function toApiFailure(error: unknown): ApiFailure {
  const carried = (error as { failure?: unknown } | null)?.failure;
  return isApiFailure(carried) ? carried : { status: 0 };
}

export function describeApiFailure(failure: ApiFailure, fallbackMessage: string): string {
  if (UNAUTHENTICATED_STATUSES.includes(failure.status)) return SESSION_EXPIRED_MESSAGE;

  const known = failure.code === undefined ? undefined : CODE_MESSAGES[failure.code];
  if (known !== undefined) return known;

  if (failure.status >= 500 || failure.status === 0) return fallbackMessage;

  const message = failure.message?.trim();
  if (message === undefined || message === "") return fallbackMessage;

  return failure.sheetTitle ? `Sheet "${failure.sheetTitle}": ${message}` : message;
}

/* -------------------------------------------------------------------------- */
/* Request helper                                                              */
/* -------------------------------------------------------------------------- */

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  try {
    return ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(envelope: Record<string, unknown>, key: string): string | undefined {
  const value = envelope[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Sends one request and returns the parsed body with its status, so a
 * multi-status (207) answer stays a success the caller can inspect. Any
 * non-2xx answer is raised as an `ApiRequestError` carrying the envelope.
 */
export async function requestApi<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: T }> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError({ status: 0 }, "The request could not be sent.");
  }

  const envelope = await readEnvelope(response);

  if (!response.ok) {
    const failure: ApiFailure = {
      status: response.status,
      code: readString(envelope, "code"),
      message: readString(envelope, "error"),
      sheetTitle: readString(envelope, "sheetTitle") ?? null,
    };
    throw new ApiRequestError(failure, failure.message ?? "The request was rejected.");
  }

  return { status: response.status, body: envelope as T };
}

/* -------------------------------------------------------------------------- */
/* ErrorNotice                                                                 */
/* -------------------------------------------------------------------------- */

/** Where the failure belongs, and therefore how much of the page it takes. */
export type ErrorScope = "page" | "section" | "card";

export interface ErrorNoticeProps {
  /** What happened. One sentence, English, already actionable. */
  title: string;
  /** Whether the data is safe, and what to do next. */
  detail?: ReactNode;
  /**
   * `card` keeps one unreadable file a card error, so the other rows on a
   * dashboard still render. Only a failure that invalidates the page is `page`.
   */
  scope?: ErrorScope;
  onRetry?: () => void;
  onResume?: () => void;
  onReload?: () => void;
  /** Shows the re-authentication link. It is a link, so it needs no handler. */
  reauthenticate?: boolean;
  retryLabel?: string;
  resumeLabel?: string;
  reloadLabel?: string;
  reauthenticateLabel?: string;
  /** Disables every recovery control while one is already running. */
  busy?: boolean;
  /**
   * The route's `debug` envelope. Present only when the server-side
   * `APP_DEBUG_ERRORS=1` switch is on; sanitized again before it is drawn.
   */
  diagnostic?: unknown;
  children?: ReactNode;
}

export function ErrorNotice({
  title,
  detail,
  scope = "section",
  onRetry,
  onResume,
  onReload,
  reauthenticate = false,
  retryLabel = "Try again",
  resumeLabel = "Resume",
  reloadLabel = "Reload",
  reauthenticateLabel = "Re-authenticate",
  busy = false,
  diagnostic,
  children,
}: ErrorNoticeProps) {
  const safeDiagnostic = toSafeDiagnostic(diagnostic);

  const buttons: ReadonlyArray<readonly [label: string, handler: () => void]> = [
    ...(onRetry ? ([[retryLabel, onRetry]] as const) : []),
    ...(onResume ? ([[resumeLabel, onResume]] as const) : []),
    ...(onReload ? ([[reloadLabel, onReload]] as const) : []),
  ];

  return (
    <div className={`api-error api-error-${scope}`}>
      <p role="alert" className="api-error-title">
        {title}
      </p>

      {detail ? <p className="api-error-detail">{detail}</p> : null}
      {children}

      {buttons.length > 0 || reauthenticate ? (
        <div className="card-actions">
          {buttons.map(([label, handler]) => (
            <button
              key={label}
              type="button"
              className="btn-secondary"
              onClick={handler}
              disabled={busy}
            >
              {label}
            </button>
          ))}

          {reauthenticate ? (
            <a className="action action-primary" href="/login">
              {reauthenticateLabel}
            </a>
          ) : null}
        </div>
      ) : null}

      {safeDiagnostic ? <TechnicalDetails diagnostic={safeDiagnostic} /> : null}
    </div>
  );
}

/**
 * The sanitized provider diagnostic, collapsed.
 *
 * It is a `<details>` rather than a toggle this component drives, so the open
 * state is the browser's and no effect or state is needed for it. Only fields
 * that survived `toSafeDiagnostic` are listed; a `null` field is simply absent,
 * which is how "the gateway could not prove this safe" reads on screen.
 */
function TechnicalDetails({ diagnostic }: { diagnostic: SafeDiagnostic }) {
  const rows = SAFE_DIAGNOSTIC_FIELDS.flatMap((field) => {
    const value = diagnostic[field];
    return value === null ? [] : [[field, String(value)] as const];
  });

  return (
    <details className="debug-error-disclosure">
      <summary>
        <span className="debug-error-label">Technical details</span>
        <span className="debug-error-badge">DEBUG</span>
      </summary>

      <dl className="debug-error">
        {rows.map(([field, value]) => (
          <div key={field} className="debug-error-row">
            <dt>{SAFE_DIAGNOSTIC_LABELS[field]}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <p className="debug-error-note">
        Secrets, OAuth tokens, cookies and credentials are removed before this is shown.
      </p>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* ApiErrorNotice — the envelope-driven adapter                                */
/* -------------------------------------------------------------------------- */

export interface ApiErrorNoticeProps {
  failure: ApiFailure | null;
  /** Shown whenever the failure carries nothing a person can act on. */
  fallbackMessage: string;
  onRetry?: () => void;
  retryLabel?: string;
  isRetrying?: boolean;
  scope?: ErrorScope;
  /** The route's `debug` envelope, when the server attached one. */
  diagnostic?: unknown;
}

/**
 * Renders an `ApiFailure` through `ErrorNotice`.
 *
 * An expired session replaces Retry with re-authentication: retrying a request
 * that has no session only fails again. Its link keeps the wording the wizards
 * already use, so one vocabulary change does not silently rename an action a
 * person has learned.
 */
export function ApiErrorNotice({
  failure,
  fallbackMessage,
  onRetry,
  retryLabel = "Try again",
  isRetrying = false,
  scope = "section",
  diagnostic,
}: ApiErrorNoticeProps) {
  if (failure === null) return null;

  const needsSignIn = UNAUTHENTICATED_STATUSES.includes(failure.status);

  return (
    <ErrorNotice
      title={describeApiFailure(failure, fallbackMessage)}
      scope={scope}
      onRetry={needsSignIn ? undefined : onRetry}
      retryLabel={retryLabel}
      reauthenticate={needsSignIn}
      reauthenticateLabel="Sign in again"
      busy={isRetrying}
      diagnostic={diagnostic}
    />
  );
}
