/**
 * The browser transport `syncCalendar` runs on.
 *
 * It addresses this application's own Route Handlers — never Google — and its
 * whole job is to turn an HTTP outcome into one of four `SyncFailureKind`
 * values, so the orchestrator never has to reason about status codes and the
 * screens never have to reason about either.
 *
 * The mapping is deliberate rather than mechanical:
 *
 * - a `fetch` that throws is `offline`: the request never reached the server,
 *   so nothing was read and nothing was changed;
 * - `401` is `authentication` — the Google session expired;
 * - `403`, `404`, and `422` are `forbidden`: a refusal about *this file*, with
 *   its own recovery step, not a system fault;
 * - everything else, `502` included, is `provider`. A disabled Sheets API
 *   arrives here, and it must read as "Google could not be used", never as an
 *   empty result.
 */

import type { AttendanceMonthView } from "@/lib/attendance/service";
import type { Timesheet, UnreadableFile } from "@/lib/discovery/file-discovery";
import {
  SyncTransportError,
  type DiscoveryResult,
  type SyncFailureKind,
  type SyncTransport,
} from "./calendar-sync";
import { sharedFetch } from "./shared-fetch";

const STATUS_KIND: Record<number, SyncFailureKind> = {
  401: "authentication",
  403: "forbidden",
  404: "forbidden",
  422: "forbidden",
};

interface DashboardBody {
  timesheets?: Timesheet[];
  unreadable?: UnreadableFile[];
  error?: string;
}

async function requestJson<T>(url: string, what: string): Promise<T> {
  let response: Response;

  try {
    // Shared only while in flight, so the calendar and the file lists make one
    // Drive scan between them instead of two identical ones.
    response = await sharedFetch(url, { cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new SyncTransportError("offline", `${what} could not be requested.`);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const envelope = (body ?? {}) as { error?: string };
    throw new SyncTransportError(
      STATUS_KIND[response.status] ?? "provider",
      envelope.error ?? `${what} failed with status ${response.status}.`,
    );
  }

  return body as T;
}

function attendanceUrl(fileId: string, sheetId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/attendance/${encodeURIComponent(sheetId)}`;
}

export function createSyncTransport(): SyncTransport {
  return {
    async discover(): Promise<DiscoveryResult> {
      const body = await requestJson<DashboardBody>("/api/dashboard", "Your attendance files");

      return {
        timesheets: body.timesheets ?? [],
        // Absent on an older server, which is not the same as "nothing failed";
        // it simply means that build could not tell us, so we claim nothing.
        unreadable: body.unreadable ?? [],
      };
    },

    readMonth(fileId, sheetId): Promise<AttendanceMonthView> {
      return requestJson<AttendanceMonthView>(attendanceUrl(fileId, sheetId), "This timesheet");
    },
  };
}
