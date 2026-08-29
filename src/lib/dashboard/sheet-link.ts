/**
 * Parses a Google Sheets link (or a bare spreadsheet ID) that a user pasted.
 *
 * This is a pure convenience shortcut and never an authorization decision. The
 * ID it returns is only ever matched against files the dashboard already
 * listed for this signed-in user, and every server route still re-derives the
 * role through `authorizeFile`. A link therefore grants nothing on its own.
 *
 * The host is compared exactly so a look-alike domain such as
 * `docs.google.com.evil.test` can never resolve to a spreadsheet ID.
 */

/** The only host Google Sheets documents are served from. */
const SHEETS_HOST = "docs.google.com";

/** Drive resource IDs are URL-safe base64-ish and comfortably longer than this. */
const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

/** `/spreadsheets/d/{id}` optionally preceded by the `/u/{n}` account segment. */
const SHEETS_PATH_PATTERN = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/;

/** A `gid` is a numeric sheet ID; anything else is discarded, never guessed. */
const GID_PATTERN = /^\d+$/;

export interface SheetLink {
  spreadsheetId: string;
  /** Numeric sheet ID from `gid`, or `null` when the link did not carry one. */
  sheetId: string | null;
}

function readGid(url: URL): string | null {
  const fromQuery = url.searchParams.get("gid");
  if (fromQuery !== null && GID_PATTERN.test(fromQuery)) return fromQuery;

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fromHash = new URLSearchParams(hash).get("gid");
  if (fromHash !== null && GID_PATTERN.test(fromHash)) return fromHash;

  return null;
}

export function parseSheetLink(input: string): SheetLink | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  if (ID_PATTERN.test(trimmed)) {
    return { spreadsheetId: trimmed, sheetId: null };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Exact host match: a suffix check would accept `docs.google.com.evil.test`.
  if (url.hostname !== SHEETS_HOST) return null;

  const match = SHEETS_PATH_PATTERN.exec(url.pathname);
  if (!match) return null;

  return { spreadsheetId: match[1], sheetId: readGid(url) };
}
