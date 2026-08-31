import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { createCalendarCache, type CalendarCache } from "@/lib/cache/calendar-cache";
import { buildCalendarSnapshot } from "@/lib/cache/calendar-state";
import { createMemoryEngine } from "@/lib/cache/engine";
import type { Timesheet } from "@/lib/discovery/file-discovery";
import { SyncTransportError, type SyncTransport } from "@/lib/sync/calendar-sync";
import { CalendarPanel } from "./calendar-panel";

const EMAIL = "linh.np@blended-asia.com";
/** 2026-07-06, built from local fields so the device zone cannot shift it. */
const NOW = new Date(2026, 6, 6, 10, 0, 0);

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
  days: [
    { ...emptyDay("2026-07-01"), clockIn: 9, clockOut: 18, breakHours: 1, workHours: 8 },
    emptyDay("2026-07-02"),
    emptyDay("2026-07-03"),
  ],
  ...over,
});

interface HarnessOptions {
  timesheets?: Timesheet[];
  unreadable?: { id: string; name: string }[];
  discoverError?: Error;
  readError?: Error;
  cache?: CalendarCache;
  viewFor?: (fileId: string, sheetId: string) => AttendanceMonthView;
}

function harness(options: HarnessOptions = {}) {
  const discover = vi.fn(async () => {
    if (options.discoverError) throw options.discoverError;
    return {
      timesheets: options.timesheets ?? [timesheet()],
      unreadable: options.unreadable ?? [],
    };
  });

  const readMonth = vi.fn(async (fileId: string, sheetId: string) => {
    if (options.readError) throw options.readError;
    return options.viewFor ? options.viewFor(fileId, sheetId) : view();
  });

  const transport: SyncTransport = { discover, readMonth };
  const cache =
    options.cache ??
    createCalendarCache({ engine: createMemoryEngine(), now: () => NOW.toISOString() });

  return { transport, cache, discover, readMonth };
}

function renderPanel(options: HarnessOptions = {}) {
  const parts = harness(options);

  render(
    <CalendarPanel
      email={EMAIL}
      cache={parts.cache}
      transport={parts.transport}
      now={() => NOW}
    />,
  );

  return parts;
}

describe("CalendarPanel — first load for an account", () => {
  it("discovers the files in the background and loads the current month", async () => {
    const parts = renderPanel();

    expect(await screen.findByText(/July 2026/)).toBeTruthy();
    expect(parts.discover).toHaveBeenCalledTimes(1);
    expect(parts.readMonth).toHaveBeenCalledWith("file-1", "101");
  });

  it("marks each date Recorded or Not recorded for a screen reader", async () => {
    renderPanel();

    expect(await screen.findByText(/Wednesday, July 1, 2026, Recorded/)).toBeTruthy();
    expect(screen.getByText(/Thursday, July 2, 2026, Not recorded/)).toBeTruthy();
  });

  it("stores what it loaded, so the next open has a month to draw immediately", async () => {
    const parts = renderPanel();
    await screen.findByText(/July 2026/);

    await waitFor(async () => {
      const pointer = await parts.cache.readPointer(EMAIL);
      expect(pointer).toMatchObject({ ok: true, value: { month: "2026-07", fileId: "file-1" } });
    });

    const stored = await parts.cache.readSnapshot({
      email: EMAIL,
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
    });

    expect(stored).toMatchObject({ ok: true });
    if (stored.ok) expect(stored.value?.days).toHaveLength(3);
  });

  it("draws the cached month before the network answers", async () => {
    const cache = createCalendarCache({
      engine: createMemoryEngine(),
      now: () => NOW.toISOString(),
    });
    await cache.writeSnapshot(
      buildCalendarSnapshot({ email: EMAIL, view: view(), checkedAt: NOW.toISOString() }),
    );

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const transport: SyncTransport = {
      discover: async () => {
        await blocked;
        return { timesheets: [timesheet()], unreadable: [] };
      },
      readMonth: async () => view(),
    };

    render(<CalendarPanel email={EMAIL} cache={cache} transport={transport} now={() => NOW} />);

    // The network is still blocked, and the month is already on screen.
    expect(await screen.findByText(/July 2026/)).toBeTruthy();
    release();
  });

  it("keeps the cached month when the current month has no file, and says so", async () => {
    const cache = createCalendarCache({
      engine: createMemoryEngine(),
      now: () => NOW.toISOString(),
    });
    await cache.writeSnapshot(
      buildCalendarSnapshot({
        // A month the person was last on, which is not the current one.
        email: EMAIL,
        view: view({ month: "2026-05", days: [emptyDay("2026-05-01")] }),
        checkedAt: NOW.toISOString(),
      }),
    );

    // A sync that answers *before* the cache read and finds nothing for the
    // month it checked. This blanked the calendar until the cached month was
    // allowed to fill an empty screen regardless of who won the race.
    renderPanel({ cache, timesheets: [timesheet({ month: "2026-06" })] });

    expect(await screen.findByText(/where you left off/)).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText(/May 1, 2026, Not recorded/)).toBeTruthy();
  });
});

describe("CalendarPanel — when no file covers the month", () => {
  it("says which month it looked for and offers the two things a person can do", async () => {
    renderPanel({ timesheets: [timesheet({ month: "2026-06" })] });

    expect(await screen.findByText(/No timesheet covers July 2026/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Create a monthly file/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load" })).toBeTruthy();
  });

  it("loads the month the person picked instead", async () => {
    const parts = renderPanel({
      timesheets: [timesheet({ month: "2026-05", id: "file-may", sheetId: "55" })],
      viewFor: () => view({ fileId: "file-may", sheetId: 55, month: "2026-05", days: [emptyDay("2026-05-01")] }),
    });

    await screen.findByText(/No timesheet covers July 2026/);

    fireEvent.change(screen.getByLabelText("Load another month"), {
      target: { value: "2026-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(await screen.findByText(/May 2026/)).toBeTruthy();
    expect(parts.readMonth).toHaveBeenCalledWith("file-may", "55");
  });

  it("re-runs discovery when the person says they created the file", async () => {
    const parts = renderPanel({ timesheets: [] });

    await screen.findByText(/No timesheet covers July 2026/);
    expect(parts.discover).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load files" }));

    await waitFor(() => expect(parts.discover).toHaveBeenCalledTimes(2));
  });
});

describe("CalendarPanel — failures are disclosed, never dressed as emptiness", () => {
  it("reports a provider failure rather than an empty calendar", async () => {
    renderPanel({
      discoverError: new SyncTransportError("provider", "Google Sheets API returned 403."),
    });

    expect(await screen.findByRole("heading", { name: "Google did not respond" })).toBeTruthy();
    // The distinction the old code lost: a provider fault is not an empty Drive.
    expect(screen.queryByText(/No timesheet covers/)).toBeNull();
  });

  it("reports files it could not read alongside the ones it could", async () => {
    renderPanel({ unreadable: [{ id: "file-9", name: "202607勤怠管理表" }] });

    expect(await screen.findByText(/1 attendance file could not be read/)).toBeTruthy();
  });

  it("never guesses between two files for one month", async () => {
    renderPanel({
      timesheets: [timesheet(), timesheet({ id: "file-2", name: "202607勤怠管理表 copy" })],
    });

    expect(await screen.findByText(/More than one timesheet covers/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(2);
  });

  it("asks for a tab when the file has no mapping, instead of picking one", async () => {
    renderPanel({ timesheets: [timesheet({ sheetId: null, sheetTitle: null })] });

    expect(await screen.findByRole("link", { name: /Choose your tab/ })).toBeTruthy();
  });
});
