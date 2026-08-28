export type GoogleErrorCode = "folder-unavailable" | "file-unavailable" | "google-api-error";

export class GoogleGatewayError extends Error {
  readonly code: GoogleErrorCode;
  readonly status?: number;

  constructor(message: string, code: GoogleErrorCode, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleGatewayError";
    this.code = code;
    this.status = options?.status;
  }
}

/**
 * A dashboard/destination folder that is missing, trashed, on a Shared Drive,
 * not owned by the signed-in user, or not writable.
 */
export class FolderUnavailableError extends GoogleGatewayError {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super("Folder unavailable.", "folder-unavailable", options);
    this.name = "FolderUnavailableError";
    this.reason = reason;
  }
}

/** A spreadsheet the signed-in user can no longer address through the app. */
export class FileUnavailableError extends GoogleGatewayError {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super("File unavailable.", "file-unavailable", options);
    this.name = "FileUnavailableError";
    this.reason = reason;
  }
}

/** Any other Google transport or quota failure, stripped of provider detail. */
export class GoogleApiError extends GoogleGatewayError {
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, "google-api-error", options);
    this.name = "GoogleApiError";
  }
}

export function googleErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown } | null;
  };

  for (const value of [candidate.code, candidate.status, candidate.response?.status]) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }

  return undefined;
}

/** True for the statuses that mean "this resource is not addressable by this user". */
export function isMissingOrForbidden(error: unknown): boolean {
  const status = googleErrorStatus(error);
  return status === 403 || status === 404;
}

export function normalizeGoogleError(error: unknown, operation: string): GoogleGatewayError {
  if (error instanceof GoogleGatewayError) {
    return error;
  }

  return new GoogleApiError(`Google request failed: ${operation}.`, {
    status: googleErrorStatus(error),
    cause: error,
  });
}
