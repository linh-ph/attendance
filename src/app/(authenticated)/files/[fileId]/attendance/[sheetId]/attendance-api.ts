/**
 * The editor's only transport.
 *
 * Nothing here talks to Google: it addresses the attendance Route Handler,
 * which re-authorizes every request. A failure is normalized into one error
 * shape — status, code, and issues — so the component decides what to show
 * from the answer rather than from the transport.
 */

import type {
  AttendanceMonthView,
  AttendancePatch,
  SaveAttendanceResult,
} from "@/lib/attendance/service";
import type { ValidationIssue } from "@/lib/attendance/validation";
import { LOAD_FAILED, SAVE_FAILED } from "./attendance-labels";

export interface AttendanceSaveInput {
  /** `YYYY-MM-DD` inside the configured month. */
  date: string;
  /** Only the dirty cells, each carrying the baseline it was read with. */
  patches: AttendancePatch[];
}

export interface AttendanceApiClient {
  read(fileId: string, sheetId: string): Promise<AttendanceMonthView>;
  save(fileId: string, sheetId: string, input: AttendanceSaveInput): Promise<SaveAttendanceResult>;
}

export interface AttendanceApiError extends Error {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  code?: string;
  issues?: ValidationIssue[];
}

function attendanceUrl(fileId: string, sheetId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/attendance/${encodeURIComponent(sheetId)}`;
}

async function requestJson<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    // The request never reached the server; the draft is untouched either way.
    const error = new Error(fallback) as AttendanceApiError;
    error.status = 0;
    throw error;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const envelope = (body ?? {}) as { error?: string; code?: string; issues?: ValidationIssue[] };
    const error = new Error(envelope.error ?? fallback) as AttendanceApiError;
    error.status = response.status;
    error.code = envelope.code;
    error.issues = envelope.issues;
    throw error;
  }

  return body as T;
}

export const attendanceApiClient: AttendanceApiClient = {
  read: (fileId, sheetId) =>
    requestJson<AttendanceMonthView>(attendanceUrl(fileId, sheetId), LOAD_FAILED),
  save: (fileId, sheetId, input) =>
    requestJson<SaveAttendanceResult>(attendanceUrl(fileId, sheetId), SAVE_FAILED, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};

/* -------------------------------------------------------------------------- */
/* Rejection readers                                                           */
/* -------------------------------------------------------------------------- */

export function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

export function issuesOf(error: unknown): ValidationIssue[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as ValidationIssue[]) : [];
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
