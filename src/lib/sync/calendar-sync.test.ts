import { describe, expect, it, vi } from "vitest";
import { emptyDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { createCalendarCache, type CalendarCache } from "@/lib/cache/calendar-cache";
import { CacheStorageError, createMemoryEngine } from "@/lib/cache/engine";
import type { Timesheet } from "@/lib/discovery/file-discovery";
import {
  currentMonth,
  resolveCalendarContext,
  syncCalendar,
  SyncTransportError,
  type SyncDependencies,
  type SyncTransport,
} from "./calendar-sync";

const EMAIL = "linh.np@blended-asia.com";
const NOW = new Date(2026, 6, 6, 10, 0, 0); // 2026-07-06, local fields

const timesheet = (over: Partial<Timesheet> = {}): Timesheet => ({
  id: "file-1",
  name: "202607勤怠管理表",
  ownerEmail: "quynh.kt@blended-asia.com",
  month: "2026-07",
  modifiedTime: "2026-07-05T00:00:00.000Z",
  sheetId: "101",
  sheetTitle: "Linh",
  tabs: [{ sheetId: "101", title: "Linh" }],
  ...over,
});

const view = (over: Partial<AttendanceMonthView> = {}): AttendanceMonthView => ({
  fileId: "file-1",
  sheetId: 101,
  sheetTitle: "Linh",
  month: "2026-07",
  spreadsheetTimeZone: "Asia/Tokyo",
  role: "employee",
  statuses: [],
  days: [emptyDay("2026-07-01"), emptyDay("2026-07-02")],
  ...over,
});

interface HarnessOptions {
  timesheets?: Timesheet[];
  unreadable?: { id: string; name: string }[];
  discoverError?: Error;
  readError?: Error;
  cache?: CalendarCache;
}

function harness(options: HarnessOptions = {}): SyncDependencies & {
  transport: SyncTransport;
  discover: ReturnType<typeof vi.fn>;
  readMonth: ReturnType<typeof vi.fn>;
  cache: CalendarCache;
} {
  const discover = vi.fn(async () => {
    if (options.discoverError) throw options.discoverError;
    return {
      timesheets: options.timesheets ?? [timesheet()],
      unreadable: options.unreadable ?? [],
    };
  });

  // The sheet, not the request, owns the month: the fake answers with the
  // month the addressed file actually covers.
  const readMonth = vi.fn(async (fileId: string, sheetId: string) => {
    if (options.readError) throw options.readError;

    const addressed = (options.timesheets ?? [timesheet()]).find((sheet) => sheet.id === fileId);

    return view({
      fileId,
      sheetId: Number(sheetId),
      month: addressed?.month ?? "2026-07",
      days: [emptyDay(`${addressed?.month ?? "2026-07"}-01`), emptyDay(`${addressed?.month ?? "2026-07"}-02`)],
    });
  });

  const transport: SyncTransport = { discover, readMonth };
  const cache =
    options.cache ?? createCalendarCache({ engine: createMemoryEngine(), now: () => NOW.toISOString() });

  return { transport, cache, now: () => NOW, discover, readMonth };
}

describe("currentMonth", () => {
  it("is the month to try first, taken from the device calendar", () => {
    expect(currentMonth(new Date(2026, 6, 6))).toBe("2026-07");
    expect(currentMonth(new Date(2026, 0, 1))).toBe("2026-01");
    expect(currentMonth(new Date(2026, 11, 31))).toBe("2026-12");
  });
});

describe("resolveCalendarContext", () => {
  it("opens directly when exactly one authorized file covers the month", () => {
    expect(resolveCalendarContext([timesheet()], "2026-07")).toEqual({
      kind: "ready",
      timesheet: timesheet(),
      sheetId: "101",
    });
  });

  it("reports none when no authorized file covers the month", () => {
    expect(resolveCalendarContext([timesheet({ month: "2026-06" })], "2026-07")).toEqual({
      kind: "none",
      month: "2026-07",
    });
  });

  it("never guesses between two files for the same month", () => {
    const candidates = [timesheet(), timesheet({ id: "file-2", name: "202607勤怠管理表 (copy)" })];

    expect(resolveCalendarContext(candidates, "2026-07")).toEqual({
      kind: "choose-file",
      candidates,
    });
  });

  it("asks for a tab rather than guessing one when the file has no mapping", () => {
    const unmapped = timesheet({ sheetId: null, sheetTitle: null });

    expect(resolveCalendarContext([unmapped], "2026-07")).toEqual({
      kind: "choose-tab",
      timesheet: unmapped,
    });
  });
});

describe("syncCalendar", () => {
  it("discovers the files, loads the current month, and caches it", async () => {
    const deps = harness();

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(deps.discover).toHaveBeenCalledTimes(1);
    expect(deps.readMonth).toHaveBeenCalledWith("file-1", "101");
    expect(report.month).toBe("2026-07");
    expect(report.context.kind).toBe("ready");
    expect(report.syncState).toBe("synced");
    expect(report.snapshot?.days).toHaveLength(2);
    expect(report.checkedAt).toBe(NOW.toISOString());

    const stored = await deps.cache.readSnapshot({
      email: EMAIL,
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
    });
    expect(stored).toMatchObject({ ok: true });
  });

  it("moves the stored pointer onto the month it loaded", async () => {
    const deps = harness();
    await syncCalendar(deps, { email: EMAIL });

    const pointer = await deps.cache.readPointer(EMAIL);
    expect(pointer).toMatchObject({ ok: true, value: { month: "2026-07", fileId: "file-1" } });
  });

  it("loads the month the caller asked for instead of the current one", async () => {
    const deps = harness({ timesheets: [timesheet({ month: "2026-05" })] });

    const report = await syncCalendar(deps, { email: EMAIL, month: "2026-05" });

    expect(report.month).toBe("2026-05");
    expect(report.context.kind).toBe("ready");
  });

  it("does not read any month when nothing covers it, and says which month that was", async () => {
    const deps = harness({ timesheets: [timesheet({ month: "2026-06" })] });

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(deps.readMonth).not.toHaveBeenCalled();
    expect(report.context).toEqual({ kind: "none", month: "2026-07" });
    // Nothing was synced, so there is no sync state to claim.
    expect(report.syncState).toBeNull();
    expect(report.timesheets).toHaveLength(1);
  });

  it("loads an explicitly chosen file and tab", async () => {
    const other = timesheet({ id: "file-2", sheetId: "202", sheetTitle: "Quynh" });
    const deps = harness({ timesheets: [timesheet(), other] });

    const report = await syncCalendar(deps, { email: EMAIL, fileId: "file-2", sheetId: "202" });

    expect(deps.readMonth).toHaveBeenCalledWith("file-2", "202");
    expect(report.context.kind).toBe("ready");
  });

  it("refuses a file discovery never listed, rather than addressing it anyway", async () => {
    const deps = harness();

    const report = await syncCalendar(deps, {
      email: EMAIL,
      fileId: "file-nobody-shared",
      sheetId: "999",
    });

    expect(deps.readMonth).not.toHaveBeenCalled();
    expect(report.context.kind).not.toBe("ready");
  });

  it("refuses a tab the chosen file does not list, so a gid cannot address one", async () => {
    const deps = harness();

    const report = await syncCalendar(deps, { email: EMAIL, fileId: "file-1", sheetId: "999" });

    expect(deps.readMonth).not.toHaveBeenCalled();
    expect(report.context.kind).not.toBe("ready");
  });

  it("reports Offline when Google could not be reached at all", async () => {
    const deps = harness({ discoverError: new SyncTransportError("offline", "No network.") });

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(report.syncState).toBe("offline");
    expect(report.timesheets).toEqual([]);
    expect(report.snapshot).toBeNull();
  });

  it("reports a provider failure as Needs attention, never as an empty file list", async () => {
    const deps = harness({
      discoverError: new SyncTransportError("provider", "Google Sheets API returned 403."),
    });

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(report.syncState).toBe("needs-attention");
    expect(report.cause).toBe("provider");
  });

  it("reports an expired session as Needs attention with an authentication cause", async () => {
    const deps = harness({
      discoverError: new SyncTransportError("authentication", "Sign in again."),
    });

    expect((await syncCalendar(deps, { email: EMAIL })).cause).toBe("authentication");
  });

  it("keeps the discovered files when only the month read failed", async () => {
    const deps = harness({ readError: new SyncTransportError("provider", "Sheets is disabled.") });

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(report.timesheets).toHaveLength(1);
    expect(report.snapshot).toBeNull();
    expect(report.syncState).toBe("needs-attention");
  });

  it("carries the files it could not read so an outage is never an empty state", async () => {
    const deps = harness({
      timesheets: [],
      unreadable: [{ id: "file-9", name: "202607勤怠管理表" }],
    });

    const report = await syncCalendar(deps, { email: EMAIL });

    expect(report.unreadable).toEqual([{ id: "file-9", name: "202607勤怠管理表" }]);
  });

  it("still returns the month when the browser refused to cache it", async () => {
    const deps = harness({
      cache: createCalendarCache({
        engine: createMemoryEngine({
          fail: ({ mode }) =>
            mode === "readwrite" ? new CacheStorageError("quota", "No space left.") : null,
        }),
        now: () => NOW.toISOString(),
      }),
    });

    const report = await syncCalendar(deps, { email: EMAIL });

    // The sheet was read successfully; only the local copy failed, and the
    // state says exactly that rather than claiming the month is cached.
    expect(report.snapshot).not.toBeNull();
    expect(report.syncState).toBe("local-storage-unavailable");
    expect(report.cacheFailure).toBe("quota");
  });
});
