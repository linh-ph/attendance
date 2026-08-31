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
  view: AttendanceMonthView;
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
    view: input.view,
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

  return (
    isNonEmptyString(value.checkedAt) &&
    isRecord(value.view) &&
    Array.isArray((value.view as Record<string, unknown>).days) &&
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
