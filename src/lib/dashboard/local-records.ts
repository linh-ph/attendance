/**
 * Keys and stored-value guards for the browser-local attendance store.
 *
 * Everything here is pure: no IndexedDB, no React, no Google types. The
 * adapter in `local-store.ts` performs the I/O.
 *
 * Two rules hold for every record:
 *
 * 1. Every key is scoped to the normalized signed-in email, so two accounts
 *    sharing a browser profile can never read each other's records.
 * 2. Nothing stored here is authoritative. Drafts and cached months are a
 *    convenience; the server re-reads the sheet and re-authorizes every
 *    request. A stored value is never an authorization result and never a
 *    token.
 */

import type { AttendanceDay } from "@/lib/attendance/model";
import type { CachedMonthView } from "@/lib/cache/records";

/** Most-recent-first; older entries fall off the end. */
export const RECENT_FILE_LIMIT = 10;

export interface RecentFile {
  fileId: string;
  /** Numeric sheet ID, as a string, matching the rest of the app. */
  sheetId: string;
  name: string;
  sheetTitle: string;
  /** ISO timestamp of the last time this sheet was opened. */
  openedAt: string;
}

/**
 * One colleague kept in this browser's roster, so a file can be created without
 * retyping the same addresses every month.
 *
 * The address is the identity and is stored normalized. `displayName` becomes
 * the employee tab title, so it is kept exactly as it was typed.
 */
export interface StoredMember {
  email: string;
  displayName: string;
}

export interface DraftRecord {
  /** Normalized email; kept in the value so a mis-scoped read is detectable. */
  email: string;
  day: AttendanceDay;
  /**
   * The sheet row exactly as it was read when this draft was made. A draft is
   * only ever restored onto an identical baseline: if the sheet moved on, the
   * stored edits are dropped rather than silently replayed over newer data.
   */
  baseline: AttendanceDay;
}

export interface MonthCacheRecord {
  email: string;
  /** No `role`: an authorization result is never persisted (spec §5.1). */
  view: CachedMonthView;
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * No email, Drive file ID, numeric sheet ID, or ISO date can contain this, so
 * concatenated keys cannot collide across components.
 */
const KEY_SEPARATOR = "::";

export function scopeKey(email: string): string {
  return email.trim().toLowerCase();
}

export function draftKey(email: string, fileId: string, sheetId: string, date: string): string {
  return [scopeKey(email), fileId, sheetId, date].join(KEY_SEPARATOR);
}

export function monthCacheKey(email: string, fileId: string, sheetId: string): string {
  return [scopeKey(email), fileId, sheetId].join(KEY_SEPARATOR);
}

export function recentKey(email: string): string {
  return scopeKey(email);
}

export function memberKey(email: string): string {
  return scopeKey(email);
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Returns a new list holding `member`, ordered by name. The address is the
 * identity, so adding the same person again with a corrected name updates that
 * name instead of duplicating the row. The input list is never mutated.
 */
export function addStoredMember(
  list: readonly StoredMember[],
  member: StoredMember,
): StoredMember[] {
  const withoutMember = list.filter((candidate) => candidate.email !== member.email);

  return [...withoutMember, member].sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) || left.email.localeCompare(right.email),
  );
}

export function removeStoredMember(
  list: readonly StoredMember[],
  email: string,
): StoredMember[] {
  return list.filter((candidate) => candidate.email !== email);
}

/* -------------------------------------------------------------------------- */
/* Recent list                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns a new list with `entry` first, any earlier visit to the same sheet
 * removed, and the length capped. The input list is never mutated.
 */
export function addRecentFile(
  list: readonly RecentFile[],
  entry: RecentFile,
): RecentFile[] {
  const withoutEntry = list.filter(
    (candidate) => !(candidate.fileId === entry.fileId && candidate.sheetId === entry.sheetId),
  );

  return [entry, ...withoutEntry].slice(0, RECENT_FILE_LIMIT);
}

/* -------------------------------------------------------------------------- */
/* Stored-value guards                                                         */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structural checks only. A stored value that fails any of these is treated as
 * absent and discarded, exactly as the folder preference does, so a corrupted
 * or foreign record can never reach the editor.
 */
export function isRecentFile(value: unknown): value is RecentFile {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.sheetId) &&
    isNonEmptyString(value.name) &&
    typeof value.sheetTitle === "string" &&
    isNonEmptyString(value.openedAt)
  );
}

export function isStoredMember(value: unknown): value is StoredMember {
  if (!isRecord(value)) return false;

  return isNonEmptyString(value.email) && typeof value.displayName === "string";
}

export function isDraftRecord(value: unknown): value is DraftRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.email) &&
    isRecord(value.day) &&
    isRecord(value.baseline)
  );
}

/**
 * A month record written before this build carries the `role` that
 * `authorizeFile` returned. Rejecting it means such a record can never hand an
 * authorization result back to a caller: the read misses, the month is fetched
 * from the server, and the next write stores the role-free shape.
 */
export function isMonthCacheRecord(value: unknown): value is MonthCacheRecord {
  if (!isRecord(value) || !isNonEmptyString(value.email) || !isRecord(value.view)) return false;

  return value.view.role === undefined;
}
