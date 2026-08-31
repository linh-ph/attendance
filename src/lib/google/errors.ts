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
const REDACTED = "[REDACTED]";

/**
 * How much plain readable text a field must still carry after redaction. Below
 * this the field is dropped instead of returned: spec §8.3 requires that a
 * provider message which cannot meet the boundary is omitted rather than
 * returned verbatim, and a field made almost entirely of redaction markers
 * proves nothing except that something was hidden.
 */
const MIN_INFORMATIVE_LETTERS = 3;

/**
 * The shortest opaque credential-alphabet run treated as a secret by shape.
 * Provider prose does not contain 32 unbroken base64/base64url/hex characters;
 * tokens, signatures, encoded payloads, and opaque ids all do. This threshold
 * matches the browser-side gate in `src/components/sync-status/safe-diagnostic.ts`,
 * so nothing the server keeps here would survive rendering anyway.
 */
const OPAQUE_RUN_LENGTH = 32;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Percent-decodes each escape run on its own.
 *
 * Decoding the whole string would throw on an ordinary `100% consumed` and take
 * the rest of the message with it — which is precisely when an encoded
 * credential elsewhere in the same string would survive unexamined. Per-run
 * decoding cannot be defeated that way; a run that will not decode is left
 * exactly as it was.
 */
function decodePercentEscapes(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Every written form of a known secret worth matching. Text is decoded before
 * matching, so the raw form covers the common case; the encoded form still
 * matters for a run that would not decode.
 */
function secretForms(secret: string): readonly string[] {
  const forms = new Set<string>([secret]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
    /* A lone surrogate cannot be encoded; the raw form still applies. */
  }
  return [...forms];
}

function redactExactSecrets(value: string, additionalSecrets: readonly string[]): string {
  return [process.env.AUTH_SECRET, process.env.AUTH_GOOGLE_SECRET, ...additionalSecrets]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 4)
    .flatMap(secretForms)
    .reduce<string>((redacted, form) => redacted.split(form).join(REDACTED), value);
}

/**
 * A URL's query string is never disclosed, whatever it happens to carry — spec
 * §8.3 excludes URLs with query strings outright.
 */
const QUERY_STRING_PATTERN = /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]*/gi;

/**
 * Labeled credentials. The capture keeps the label and its separator so the
 * message still says *what* was withheld; everything after it goes.
 */
const LABELED_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /*
   * An authorization or cookie header value is consumed whole, up to the next
   * `;`, `,`, or line break. The previous rule stopped at the first space and
   * so redacted only the scheme word, leaving `Basic <base64>` in the clear.
   */
  /(\b(?:authorization|proxy-authorization|www-authenticate|cookie|set-cookie|x-e2e-secret)\b\s*[:=]\s*)[^;,\n]*/gi,
  // The same schemes wherever they appear without a header label.
  /(\b(?:bearer|basic|digest|negotiate)\s+)[^\s;,"']+/gi,
  // Credential parameters, in either the underscore or the hyphen spelling.
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|app[_-]?secret|auth[_-]?secret|api[_-]?key|private[_-]?key|credentials?|password|passwd|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
];

/** Credential *shapes*, matched without knowing either a label or a value. */
const OPAQUE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Google's own credential prefixes.
  /\bya29\.[A-Za-z0-9._~+/-]{4,}=*/g,
  /\b1\/\/[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bGOCSPX-[A-Za-z0-9._~+/-]{4,}/g,
  /\bAIza[A-Za-z0-9._~+/-]{8,}/g,
  // A JWT in any of its three-segment forms.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /*
   * Any remaining long opaque base64, base64url, or hex run. This deliberately
   * also catches an opaque Drive file id: the gateway must be able to *prove* a
   * value safe, not merely fail to prove it dangerous, and no length separates
   * a 44-character file id from a 44-character base64 secret.
   */
  new RegExp(
    `(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{${OPAQUE_RUN_LENGTH},}={0,2}`,
    "g",
  ),
];

/**
 * Adjacent markers left by overlapping rules read as if something informative
 * sat between them. Collapse them into one.
 */
function collapseMarkers(value: string): string {
  return value.replace(/(?:\[REDACTED\][\s;,]*){2,}/g, `${REDACTED} `).trim();
}

/** How much readable text is left once every redaction marker is removed. */
function informativeLength(value: string): number {
  return value.split(REDACTED).join(" ").replace(/[^A-Za-z]/g, "").length;
}

/**
 * Keep provider diagnostics useful without returning credentials or request
 * payloads — spec §8.3.
 *
 * Text is percent-decoded per escape run first, so an encoded label such as
 * `refresh_token%3D1%2F%2F…` cannot walk past a rule that needs a literal `=`,
 * and an encoded form of a secret this process holds cannot walk past the
 * value-based rules. Matching is then by label *and* by shape, and a field that
 * redacts down to nothing readable is dropped rather than returned.
 */
function sanitizeDiagnosticText(
  value: string | undefined,
  additionalSecrets: readonly string[],
): string | null {
  if (!value) return null;

  const decoded = decodePercentEscapes(value.trim());
  const withoutKnownSecrets = redactExactSecrets(decoded, additionalSecrets);

  const withoutQueryStrings = withoutKnownSecrets.replace(
    QUERY_STRING_PATTERN,
    `$1?${REDACTED}`,
  );

  const withoutLabeled = LABELED_CREDENTIAL_PATTERNS.reduce<string>(
    (text, pattern) => text.replace(pattern, `$1${REDACTED}`),
    withoutQueryStrings,
  );

  const redacted = collapseMarkers(
    OPAQUE_CREDENTIAL_PATTERNS.reduce<string>(
      (text, pattern) => text.replace(pattern, REDACTED),
      withoutLabeled,
    ),
  );

  if (informativeLength(redacted) < MIN_INFORMATIVE_LETTERS) return null;

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
