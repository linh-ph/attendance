/**
 * Cache keys and the credential guard.
 *
 * Pure: no IndexedDB, no React, no Google types.
 *
 * Two rules hold for every key:
 *
 * 1. It is scoped by the **normalized signed-in email**, the Drive file, the
 *    numeric sheet ID, the month, and the **schema version**. Two accounts
 *    sharing a browser profile can never read each other's records, and a
 *    record written by an older build of the app can never be mistaken for one
 *    written by this build (spec §5.1).
 * 2. It is parseable, so a migration can find what exists without guessing.
 *
 * Nothing stored under these keys is authoritative: the server re-reads the
 * sheet and re-authorizes every request.
 */

/**
 * Raised whenever the shape of a stored record changes. A new version means a
 * new key namespace, so old records are found by a deliberate migration rather
 * than misread by a reader that does not understand them.
 */
export const CACHE_SCHEMA_VERSION = 1;

export interface CacheContext {
  /** The signed-in account. Normalized on the way into every key. */
  email: string;
  fileId: string;
  /** Numeric sheet ID, as a string, matching the rest of the app. */
  sheetId: string;
  /** `YYYY-MM`. */
  month: string;
}

export interface ParsedCacheKey {
  schemaVersion: number;
  account: string;
  fileId: string;
  sheetId: string;
  month: string;
  /** The date for a draft key; `null` for a month key. */
  date: string | null;
}

/**
 * No email, Drive file ID, numeric sheet ID, month, or ISO date can contain
 * this, so concatenated keys cannot collide across components.
 */
const KEY_SEPARATOR = "::";

const MONTH_PREFIX = "m";
const DRAFT_PREFIX = "d";

export function normalizeAccount(email: string): string {
  return email.trim().toLowerCase();
}

export function contextKey(context: CacheContext, schemaVersion = CACHE_SCHEMA_VERSION): string {
  return [
    `v${schemaVersion}`,
    normalizeAccount(context.email),
    context.fileId,
    context.sheetId,
    context.month,
  ].join(KEY_SEPARATOR);
}

export function monthCacheKey(context: CacheContext, schemaVersion = CACHE_SCHEMA_VERSION): string {
  return [MONTH_PREFIX, contextKey(context, schemaVersion)].join(KEY_SEPARATOR);
}

export function draftCacheKey(
  context: CacheContext,
  date: string,
  schemaVersion = CACHE_SCHEMA_VERSION,
): string {
  return [DRAFT_PREFIX, contextKey(context, schemaVersion), date].join(KEY_SEPARATOR);
}

export function parseCacheKey(key: string): ParsedCacheKey | null {
  const parts = key.split(KEY_SEPARATOR);
  if (parts.length < 6 || parts.length > 7) return null;

  const [prefix, version, account, fileId, sheetId, month, date] = parts;

  if (prefix !== MONTH_PREFIX && prefix !== DRAFT_PREFIX) return null;
  if (prefix === MONTH_PREFIX && parts.length !== 6) return null;
  if (prefix === DRAFT_PREFIX && parts.length !== 7) return null;
  if (!version.startsWith("v")) return null;

  const schemaVersion = Number(version.slice(1));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) return null;
  if (!account || !fileId || !sheetId || !month) return null;

  return { schemaVersion, account, fileId, sheetId, month, date: date ?? null };
}

/* -------------------------------------------------------------------------- */
/* Credential guard                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Property names that may never appear anywhere inside a stored record.
 * Compared with separators and case removed, so `access_token`, `accessToken`,
 * and `Access-Token` are one entry.
 */
const FORBIDDEN_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "token",
  "bearer",
  "authorization",
  "cookie",
  "setcookie",
  "clientsecret",
  "clientid",
  "apikey",
  "privatekey",
  "secret",
  "password",
  "credential",
  "credentials",
]);

/** Google OAuth access tokens all start this way. */
const GOOGLE_TOKEN_PREFIX = "ya29.";

/** Three base64url segments — an ID token or any other JWT. */
const JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const MAX_SCAN_DEPTH = 12;

function normalizePropertyName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function looksLikeCredentialValue(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.startsWith(GOOGLE_TOKEN_PREFIX) ||
    /^bearer\s+\S+/i.test(trimmed) ||
    JWT_PATTERN.test(trimmed)
  );
}

/**
 * Returns the path of the first credential-shaped thing found, or `null`.
 *
 * `CLAUDE.md` states plainly that no token, refresh token, cookie, or
 * authorization result reaches IndexedDB. This turns that from a convention
 * into an enforced refusal: the cache calls this before every write and answers
 * `forbidden-content` rather than storing the value.
 *
 * It deliberately does **not** flag `role` on a cached month view. That field
 * is part of the month the app has always cached, it is re-derived by the
 * server on every request, and it grants nothing on its own — the server
 * re-authorizes each call regardless of what the browser holds.
 */
export function findCredentialMaterial(value: unknown, path = "", depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH) return null;

  if (typeof value === "string") {
    return looksLikeCredentialValue(value) ? path : null;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findCredentialMaterial(entry, path ? `${path}.${index}` : String(index), depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  if (value === null || typeof value !== "object") return null;

  for (const [name, entry] of Object.entries(value)) {
    const childPath = path ? `${path}.${name}` : name;

    if (FORBIDDEN_PROPERTY_NAMES.has(normalizePropertyName(name))) return childPath;

    const found = findCredentialMaterial(entry, childPath, depth + 1);
    if (found !== null) return found;
  }

  return null;
}
