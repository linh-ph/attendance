/**
 * One API-failure contract for the manager wizards.
 *
 * Every wizard request answers with the same JSON envelope (`error`, and
 * sometimes `code` and `sheetTitle`), so both the parsing of that envelope and
 * its presentation live here rather than being re-invented per wizard.
 *
 * Two rules decide what a manager reads:
 *
 * 1. A stable machine code always wins, because the English copy for a code is
 *    owned by this application.
 * 2. A server message is rendered only for a request the manager can act on
 *    (status below 500). A Google boundary failure answers 5xx, so its body is
 *    never rendered and the caller's own fallback sentence is shown instead —
 *    a provider message never reaches the screen.
 */

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
 * Sends one wizard request and returns the parsed body with its status, so a
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
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

export interface ApiErrorNoticeProps {
  failure: ApiFailure | null;
  /** Shown whenever the failure carries nothing a manager can act on. */
  fallbackMessage: string;
  onRetry?: () => void;
  retryLabel?: string;
  isRetrying?: boolean;
}

export function ApiErrorNotice({
  failure,
  fallbackMessage,
  onRetry,
  retryLabel = "Try again",
  isRetrying = false,
}: ApiErrorNoticeProps) {
  if (failure === null) return null;

  const needsSignIn = UNAUTHENTICATED_STATUSES.includes(failure.status);

  return (
    <div className="api-error">
      <p role="alert" className="form-error">
        {describeApiFailure(failure, fallbackMessage)}
      </p>

      <div className="card-actions">
        {needsSignIn ? (
          <a className="action action-primary" href="/login">
            Sign in again
          </a>
        ) : null}

        {onRetry && !needsSignIn ? (
          <button type="button" className="action" onClick={onRetry} disabled={isRetrying}>
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
