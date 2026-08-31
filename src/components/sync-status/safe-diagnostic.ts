/**
 * The last gate before a provider diagnostic is drawn on screen — spec §8.3.
 *
 * The server already narrows a Google failure to the `GoogleErrorDiagnostic`
 * envelope and redacts the secrets it knows by value. This module is the
 * browser's own gate over the same data, and it exists for three reasons:
 *
 * 1. **The allowlist is enforced where it is rendered.** Whatever object the
 *    route hands the browser, only `name`, `message`, `status`,
 *    `providerMessage`, `providerStatus`, and `providerReason` can reach the
 *    DOM. An unknown provider field, a body, a header, a config object, or a
 *    stack cannot leak by being added upstream, because nothing but those six
 *    keys is ever read.
 * 2. **Encoded credentials survive label-matching.** The server's rules key off
 *    literal labels (`Bearer x`, `access_token=x`) and off secret values it
 *    holds. A percent-encoded `refresh_token%3D1%2F%2F…` matches neither. So
 *    every value is percent-decoded first and then matched by *shape* as well
 *    as by label — Google's own credential prefixes, JWTs, Basic values, and
 *    long opaque base64/base64url/hex runs.
 * 3. **A field the gate cannot vouch for is dropped, not shown.** Spec §8.3:
 *    "if a provider message cannot meet this boundary it is omitted rather than
 *    returned verbatim". A value that redacts down to nothing readable becomes
 *    `null`, and an envelope where nothing survives becomes `null` — so no
 *    empty `Technical details` panel is offered.
 *
 * Pure module. It never reads the environment and never writes to storage:
 * diagnostics are never persisted (spec §8.3), so there is nothing here to
 * cache.
 */

/** This surface's own cap, independent of the server's, applied per field. */
export const MAX_DEBUG_FIELD_LENGTH = 1_000;

const REDACTED = "[REDACTED]";

export interface SafeDiagnostic {
  readonly name: string | null;
  readonly message: string | null;
  readonly status: number | null;
  readonly providerMessage: string | null;
  readonly providerStatus: string | null;
  readonly providerReason: string | null;
}

/** The rendering order of the disclosure. Also the whole allowlist. */
export const SAFE_DIAGNOSTIC_FIELDS = [
  "name",
  "message",
  "status",
  "providerMessage",
  "providerStatus",
  "providerReason",
] as const;

export type SafeDiagnosticField = (typeof SAFE_DIAGNOSTIC_FIELDS)[number];

export const SAFE_DIAGNOSTIC_LABELS: Record<SafeDiagnosticField, string> = {
  name: "Error",
  message: "Message",
  status: "HTTP status",
  providerMessage: "Provider message",
  providerStatus: "Provider status",
  providerReason: "Provider reason",
};

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Percent-decodes each escape run on its own.
 *
 * Decoding the whole string would throw on an ordinary `100% failed` and lose
 * the rest of the message with it, which is exactly when an encoded credential
 * elsewhere in that string would survive. Per-run decoding cannot be defeated
 * that way, and a run that will not decode is simply left as it is.
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

/** Credential-shaped things, matched without needing to know their value. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // A URL's query string: never disclosed, whatever it happens to carry.
  /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]*/gi,
  // Labeled headers and parameters, including the `Basic` and `Bearer` forms.
  /\b(bearer|basic)\s+[^\s;,"']+/gi,
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-e2e-secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret|session[_-]?token|auth[_-]?secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
  // Google's own credential prefixes, wherever they appear and unlabeled.
  /\bya29\.[A-Za-z0-9._~+/-]{4,}=*/g,
  /\b1\/\/[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bGOCSPX-[A-Za-z0-9._~+/-]{4,}/g,
  /\bAIza[A-Za-z0-9._~+/-]{8,}/g,
  // A JWT, in any of its three-segment forms.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /*
   * Any remaining long opaque run of base64, base64url, or hex. A provider
   * sentence does not contain 32 unbroken credential-alphabet characters; a
   * token, a signature, an encoded payload, and an opaque id all do. Redacting
   * an innocent identifier is the correct trade: the gate must be able to
   * *prove* a value safe, not merely fail to prove it dangerous.
   */
  /\b[A-Za-z0-9+/_-]{32,}={0,2}/g,
];

/**
 * A cookie header rewritten by the label rule still leaves `name=` visible when
 * the value was quoted oddly; collapsing runs of markers keeps the output
 * readable and keeps a partially-redacted value from looking informative.
 */
function collapseMarkers(value: string): string {
  return value.replace(/(?:\[REDACTED\][\s;,]*){2,}/g, `${REDACTED} `).trim();
}

function redact(value: string): string {
  const withQueryStripped = value.replace(CREDENTIAL_PATTERNS[0], `$1?${REDACTED}`);

  const redacted = CREDENTIAL_PATTERNS.slice(1).reduce<string>(
    (text, pattern) =>
      text.replace(pattern, (match, label: string | undefined) =>
        label ? `${label} ${REDACTED}` : REDACTED,
      ),
    withQueryStripped,
  );

  return collapseMarkers(redacted);
}

/** How much readable text is left once every redaction marker is removed. */
function informativeLength(value: string): number {
  return value.split(REDACTED).join(" ").replace(/[^A-Za-z]/g, "").length;
}

/**
 * Sanitizes one string field, or returns `null` when it cannot be vouched for.
 * Each field is decoded, redacted, and capped on its own — a long provider
 * message never eats another field's budget.
 */
export function sanitizeDiagnosticField(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const redacted = redact(decodePercentEscapes(trimmed));
  if (informativeLength(redacted) < 3) return null;

  return redacted.length > MAX_DEBUG_FIELD_LENGTH
    ? `${redacted.slice(0, MAX_DEBUG_FIELD_LENGTH)}…`
    : redacted;
}

/* -------------------------------------------------------------------------- */
/* Envelope narrowing                                                          */
/* -------------------------------------------------------------------------- */

function sanitizeStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Narrows whatever the route sent to the six allowlisted, sanitized fields.
 *
 * Returns `null` when the value is not an envelope, or when nothing in it
 * survives sanitization — the caller renders no disclosure at all rather than
 * an empty one.
 */
export function toSafeDiagnostic(value: unknown): SafeDiagnostic | null {
  if (typeof value !== "object" || value === null) return null;

  /*
   * A route's envelope arrives as parsed JSON, so it is always a plain object.
   * Anything else — an `Error`, a class instance, an array — is an arbitrary
   * object spec §8.3 excludes outright, and is refused rather than mined for
   * six field names it may coincidentally have.
   */
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;

  const source = value as Record<string, unknown>;

  const safe: SafeDiagnostic = {
    name: sanitizeDiagnosticField(source.name),
    message: sanitizeDiagnosticField(source.message),
    status: sanitizeStatus(source.status),
    providerMessage: sanitizeDiagnosticField(source.providerMessage),
    providerStatus: sanitizeDiagnosticField(source.providerStatus),
    providerReason: sanitizeDiagnosticField(source.providerReason),
  };

  const hasAnything = SAFE_DIAGNOSTIC_FIELDS.some((field) => safe[field] !== null);
  return hasAnything ? safe : null;
}
