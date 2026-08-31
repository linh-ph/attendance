/**
 * The two record shapes the acknowledged cache stores, and their guards.
 *
 * Pure: no IndexedDB, no React.
 *
 * Every record carries its own scope (schema version, account, file, sheet,
 * month) even though all five are already in its key. A mis-scoped read is then
 * *detectable* rather than merely unlikely, and a record copied between
 * profiles by hand still fails its guard.
 *
 * A stored value that fails a guard is reported as `corrupt` and left where it
 * is. It is never treated as absent, and a draft is never deleted to tidy it
 * away (spec §5.6).
 */

import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { hashDay } from "./revisions";
import { normalizeAccount, type CacheContext } from "./keys";

/**
 * A month as it is allowed to be persisted: everything except the
 * authorization outcome.
 *
 * `AttendanceMonthView.role` comes straight from `authorizeFile`, so it is an
 * authorization result — the one class of value spec §5.1 and `CLAUDE.md`
 * forbid in IndexedDB, and what `access/policy.ts` means by "never a cached
 * role". Omitting it from the *type* is the point: a future consumer cannot
 * read a role that is not there, and must take it from the server response
 * that re-authorizes the request anyway.
 */
export type CachedMonthView = Omit<AttendanceMonthView, "role">;

/** Drops the authorization outcome from a month before it can be stored. */
export function stripAuthorization(view: AttendanceMonthView): CachedMonthView {
  const { role: _role, ...rest } = view;
  return rest;
}

export interface CachedMonthRecord {
  schemaVersion: number;
  account: string;
  fileId: string;
  sheetId: string;
  month: string;
  /** Monotonic. Advanced by every accepted month write and by every Save. */
  revision: number;
  /** ISO timestamp of the last successful Sheet check this record reflects. */
  checkedAt: string;
  /** No `role`: an authorization result is never persisted. */
  view: CachedMonthView;
  /** Baseline fingerprint per date, so a remote change is detectable by date. */
  baselineHashes: Record<string, string>;
}

export interface CachedDraftRecord {
  schemaVersion: number;
  account: string;
  fileId: string;
  sheetId: string;
  month: string;
  date: string;
  /** Monotonic per date. A Save clears only the revision it sent. */
  revision: number;
  updatedAt: string;
  /** The person's unsaved edit. */
  day: AttendanceDay;
  /** The sheet row exactly as read when this draft was made. */
  baseline: AttendanceDay;
  baselineHash: string;
}

export interface BuildMonthRecordInput {
  context: CacheContext;
  schemaVersion: number;
  /** Accepted whole; the authorization outcome is stripped before storing. */
  view: AttendanceMonthView;
  checkedAt: string;
  revision: number;
}

export function buildMonthRecord(input: BuildMonthRecordInput): CachedMonthRecord {
  const baselineHashes: Record<string, string> = {};
  for (const day of input.view.days) baselineHashes[day.date] = hashDay(day);

  return {
    schemaVersion: input.schemaVersion,
    account: normalizeAccount(input.context.email),
    fileId: input.context.fileId,
    sheetId: input.context.sheetId,
    month: input.context.month,
    revision: input.revision,
    checkedAt: input.checkedAt,
    view: stripAuthorization(input.view),
    baselineHashes,
  };
}

export interface BuildDraftRecordInput {
  context: CacheContext;
  schemaVersion: number;
  date: string;
  day: AttendanceDay;
  baseline: AttendanceDay;
  revision: number;
  updatedAt: string;
}

export function buildDraftRecord(input: BuildDraftRecordInput): CachedDraftRecord {
  return {
    schemaVersion: input.schemaVersion,
    account: normalizeAccount(input.context.email),
    fileId: input.context.fileId,
    sheetId: input.context.sheetId,
    month: input.context.month,
    date: input.date,
    revision: input.revision,
    updatedAt: input.updatedAt,
    day: input.day,
    baseline: input.baseline,
    baselineHash: hashDay(input.baseline),
  };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasScope(value: Record<string, unknown>): boolean {
  return (
    isRevision(value.schemaVersion) &&
    isNonEmptyString(value.account) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.sheetId) &&
    isNonEmptyString(value.month) &&
    isRevision(value.revision)
  );
}

export function isCachedMonthRecord(value: unknown): value is CachedMonthRecord {
  if (!isRecord(value) || !hasScope(value)) return false;

  const view = value.view;

  return (
    isNonEmptyString(value.checkedAt) &&
    isRecord(view) &&
    Array.isArray(view.days) &&
    // A record carrying an authorization outcome is not one this build wrote.
    // Refusing it here means a tampered or foreign record cannot hand a role
    // back to a caller either — it reads as `corrupt`, never as a role.
    view.role === undefined &&
    isRecord(value.baselineHashes)
  );
}

export function isCachedDraftRecord(value: unknown): value is CachedDraftRecord {
  if (!isRecord(value) || !hasScope(value)) return false;

  return (
    isNonEmptyString(value.date) &&
    isNonEmptyString(value.updatedAt) &&
    isRecord(value.day) &&
    isRecord(value.baseline) &&
    isNonEmptyString(value.baselineHash)
  );
}
