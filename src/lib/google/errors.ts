export type GoogleErrorCode = "folder-unavailable" | "file-unavailable" | "google-api-error";

export interface GoogleErrorDiagnostic {
  name: string;
  message: string;
  status: number | null;
  providerMessage: string | null;
  providerStatus: string | null;
  providerReason: string | null;
}

const MAX_DIAGNOSTIC_LENGTH = 2_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function redactExactSecrets(value: string, additionalSecrets: readonly string[]): string {
  return [process.env.AUTH_SECRET, process.env.AUTH_GOOGLE_SECRET, ...additionalSecrets].reduce<string>(
    (redacted, secret) =>
      secret && secret.length >= 4 ? redacted.split(secret).join("[REDACTED]") : redacted,
    value,
  );
}

/** Keep provider diagnostics useful without returning credentials or request payloads. */
function sanitizeDiagnosticText(
  value: string | undefined,
  additionalSecrets: readonly string[],
): string | null {
  if (!value) return null;

  const redacted = redactExactSecrets(value.trim(), additionalSecrets)
    .replace(/(Bearer\s+)[^\s;,]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:access_token|refresh_token|client_secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bAuthorization\b\s*[:=]\s*)(?!Bearer\b)[^\s;,]+/gi, "$1[REDACTED]");

  return redacted.length > MAX_DIAGNOSTIC_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : redacted;
}

export function debugErrorsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.APP_DEBUG_ERRORS === "1";
}

/** Extract only an allowlisted, sanitized subset of a Google/Gaxios failure. */
export function toGoogleErrorDiagnostic(
  error: unknown,
  additionalSecrets: readonly string[] = [],
): GoogleErrorDiagnostic {
  const errorRecord = asRecord(error);
  const cause = asRecord(errorRecord?.cause);
  const response = asRecord(cause?.response);
  const data = asRecord(response?.data);
  const provider = asRecord(data?.error);
  const providerErrors = Array.isArray(provider?.errors) ? provider.errors : [];
  const providerDetails = Array.isArray(provider?.details) ? provider.details : [];
  const firstProviderError = asRecord(providerErrors[0]);
  const firstProviderDetail = asRecord(providerDetails[0]);
  const sanitize = (value: unknown) => sanitizeDiagnosticText(asString(value), additionalSecrets);

  return {
    name: sanitize(errorRecord?.name) ?? "Error",
    message: sanitize(errorRecord?.message) ?? "Unknown error.",
    status: googleErrorStatus(error) ?? googleErrorStatus(errorRecord?.cause) ?? null,
    providerMessage: sanitize(provider?.message) ?? sanitize(cause?.message),
    providerStatus: sanitize(provider?.status),
    providerReason: sanitize(firstProviderError?.reason) ?? sanitize(firstProviderDetail?.reason),
  };
}

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
