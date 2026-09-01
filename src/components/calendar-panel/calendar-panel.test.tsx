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

/**
 * The grid's accessible name is its caption, so asking for the table by month
 * is both precise and the thing a screen-reader user would use to find it.
 */
const grid = (month: string | RegExp) =>
  screen.findByRole("table", { name: typeof month === "string" ? new RegExp(month) : month });

describe("CalendarPanel — the calendar is drawn from the month, not from the data", () => {
  it("draws a full month grid even when the account has no timesheet at all", async () => {
    renderPanel({ timesheets: [] });

    // July 2026 has 31 days and starts on a Wednesday, so the grid runs from
    // Sunday 28 June to Saturday 1 August: five complete weeks.
    const table = await grid("July 2026");
    const rows = table.querySelectorAll("tbody tr");

    expect(rows).toHaveLength(5);
    rows.forEach((row) => expect(row.querySelectorAll("td")).toHaveLength(7));

    expect(screen.getByText(/Wednesday, July 1, 2026, No timesheet data/)).toBeTruthy();
    expect(screen.getByText(/Friday, July 31, 2026, No timesheet data/)).toBeTruthy();
  });

  it("completes the first and last weeks with real neighbouring dates", async () => {
    renderPanel({ timesheets: [] });
    await grid("July 2026");

    expect(screen.getByText(/Sunday, June 28, 2026, outside July 2026/)).toBeTruthy();
    expect(screen.getByText(/Saturday, August 1, 2026, outside July 2026/)).toBeTruthy();
  });

  it("still marks weekends when there is no data to read them from", async () => {
    renderPanel({ timesheets: [] });
    await grid("July 2026");

    // 2026-07-04 is a Saturday; the date alone is enough to know that.
    expect(screen.getByText(/Saturday, July 4, 2026, No timesheet data, weekend/)).toBeTruthy();
  });

  it("moves to another month and keeps drawing, with or without a timesheet", async () => {
    renderPanel({ timesheets: [] });
    await grid("July 2026");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await grid("August 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await grid("June 2026")).toBeTruthy();
  });
});

describe("CalendarPanel — first load for an account", () => {
  it("discovers the files in the background and loads the current month", async () => {
    const parts = renderPanel();

    expect(await grid("July 2026")).toBeTruthy();
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
    await grid("July 2026");

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

    // The network is still blocked, and the month's data is already on screen.
    expect(await screen.findByText(/Wednesday, July 1, 2026, Recorded/)).toBeTruthy();
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
  it("explains the empty calendar underneath it, instead of replacing it", async () => {
    renderPanel({ timesheets: [timesheet({ month: "2026-06" })] });

    expect(
      await screen.findByText(/calendar above is empty because no timesheet covers July 2026/),
    ).toBeTruthy();
    // The calendar itself is still there — that is the whole point.
    expect(screen.getByRole("table", { name: /July 2026/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Create a monthly file/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load" })).toBeTruthy();
  });

  it("loads the month the person picked instead", async () => {
    const parts = renderPanel({
      timesheets: [timesheet({ month: "2026-05", id: "file-may", sheetId: "55" })],
      viewFor: () => view({ fileId: "file-may", sheetId: 55, month: "2026-05", days: [emptyDay("2026-05-01")] }),
    });

    await grid("July 2026");

    fireEvent.change(screen.getByLabelText("Load another month"), {
      target: { value: "2026-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(await grid("May 2026")).toBeTruthy();
    expect(parts.readMonth).toHaveBeenCalledWith("file-may", "55");
  });

  it("re-runs discovery when the person says they created the file", async () => {
    const parts = renderPanel({ timesheets: [] });

    await grid("July 2026");
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
