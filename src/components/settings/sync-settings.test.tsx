import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { createAttendanceCache } from "@/lib/cache/attendance-cache";
import { createCalendarPointerStore } from "@/lib/cache/calendar-pointer";
import {
  CacheStorageError,
  createMemoryEngine,
  type MemoryEngineOptions,
} from "@/lib/cache/engine";
import type { Timesheet } from "@/lib/discovery/file-discovery";
import { SyncTransportError, type SyncTransport } from "@/lib/sync/calendar-sync";
import { SyncSettings } from "./sync-settings";

const EMAIL = "linh.np@blended-asia.com";
const NOW = new Date(2026, 6, 6, 10, 0, 0);

const timesheet = (over: Partial<Timesheet> = {}): Timesheet => ({
  id: "file-1",
  name: "202607勤怠管理表",
  ownerEmail: "quynh.kt@blended-asia.com",
  month: "2026-07",
  modifiedTime: null,
  sheetId: "101",
  sheetTitle: "Linh",
  tabs: [{ sheetId: "101", title: "Linh" }],
  ...over,
});

const view = (): AttendanceMonthView => ({
  fileId: "file-1",
  sheetId: 101,
  sheetTitle: "Linh",
  month: "2026-07",
  spreadsheetTimeZone: "Asia/Tokyo",
  role: "open",
  statuses: [],
  days: [
    // Recorded because the work report is filled. The clock columns arrive
    // pre-filled from the template on every working day, so they say nothing.
    {
      ...emptyDay("2026-07-01"),
      clockIn: 9,
      clockOut: 18,
      breakHours: 1,
      workHours: 8,
      slots: { ...emptyDay("2026-07-01").slots, "09:00": "FMC" },
    },
    emptyDay("2026-07-02"),
    emptyDay("2026-07-03"),
  ],
});

interface Options {
  timesheets?: Timesheet[];
  unreadable?: { id: string; name: string }[];
  discoverError?: Error;
  engineFail?: MemoryEngineOptions["fail"];
}

function renderSettings(options: Options = {}) {
  const discover = vi.fn(async () => {
    if (options.discoverError) throw options.discoverError;
    return { timesheets: options.timesheets ?? [timesheet()], unreadable: options.unreadable ?? [] };
  });

  const readMonth = vi.fn(async () => view());
  const transport: SyncTransport = { discover, readMonth };

  // One database behind the month store and the pointer, as the browser has.
  const engine = createMemoryEngine({ fail: options.engineFail });
  const cache = createAttendanceCache({ engine, now: () => NOW.toISOString() });
  const pointer = createCalendarPointerStore({ engine, now: () => NOW.toISOString() });

  render(
    <SyncSettings
      email={EMAIL}
      cache={cache}
      pointer={pointer}
      transport={transport}
      now={() => NOW}
    />,
  );

  return { discover, readMonth, cache, pointer };
}

const syncButton = () => screen.getByRole("button", { name: /Sync now|Syncing/ });

describe("SyncSettings", () => {
  it("does nothing until the person asks for it", () => {
    const { discover, readMonth } = renderSettings();

    expect(discover).not.toHaveBeenCalled();
    expect(readMonth).not.toHaveBeenCalled();
  });

  it("reads Google Sheets into this browser's copy and reports what it stored", async () => {
    const { discover, readMonth, cache } = renderSettings();

    fireEvent.click(syncButton());

    expect(await screen.findByText("July 2026")).toBeTruthy();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(readMonth).toHaveBeenCalledWith("file-1", "101");

    // Counted from the domain rule: one recorded day, two working days empty.
    expect(screen.getByText("1 of 3")).toBeTruthy();

    const stored = await cache.readMonth({
      email: EMAIL,
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
    });
    expect(stored).toMatchObject({ ok: true });
    if (stored.ok) expect(stored.value?.view.days).toHaveLength(3);
  });

  it("records where the calendar now is, so a cold open finds the month", async () => {
    const { pointer } = renderSettings();

    fireEvent.click(syncButton());
    await screen.findByText("July 2026");

    expect(await pointer.read(EMAIL)).toMatchObject({
      ok: true,
      value: { fileId: "file-1", sheetId: "101", month: "2026-07" },
    });
  });

  it("says the sheet was read even when the browser refused to store it", async () => {
    renderSettings({
      engineFail: ({ mode }) =>
        mode === "readwrite" ? new CacheStorageError("quota", "No space left.") : null,
    });

    fireEvent.click(syncButton());

    expect(await screen.findByText(/only this browser's copy could not be written/)).toBeTruthy();
    // Never `Synced`: there is no local copy to be synced with.
    expect(screen.queryByText("Synced")).toBeNull();
  });

  it("reports a provider failure instead of an empty result", async () => {
    renderSettings({
      discoverError: new SyncTransportError("provider", "Google Sheets API returned 403."),
    });

    fireEvent.click(syncButton());

    expect(await screen.findByRole("heading", { name: "Google did not respond" })).toBeTruthy();
  });

  it("reports an expired session as one, not as a provider fault", async () => {
    renderSettings({
      discoverError: new SyncTransportError("authentication", "Sign in again."),
    });

    fireEvent.click(syncButton());

    expect(await screen.findByRole("heading", { name: "Your Google session expired" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Google did not respond" })).toBeNull();
  });

  it("says plainly when there was nothing to sync for this month", async () => {
    renderSettings({ timesheets: [timesheet({ month: "2026-06" })] });

    fireEvent.click(syncButton());

    expect(await screen.findByText(/no timesheet covers July 2026/i)).toBeTruthy();
  });

  it("discloses files it could not read rather than shrinking the count silently", async () => {
    renderSettings({ unreadable: [{ id: "file-9", name: "202607勤怠管理表" }] });

    fireEvent.click(syncButton());

    expect(await screen.findByText(/1 attendance file could not be read/)).toBeTruthy();
  });
});
