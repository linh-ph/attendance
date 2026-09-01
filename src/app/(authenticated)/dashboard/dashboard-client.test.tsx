import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttendanceCache } from "@/lib/cache/attendance-cache";
import { createCalendarPointerStore } from "@/lib/cache/calendar-pointer";
import { createMemoryEngine } from "@/lib/cache/engine";
import type { CacheContext } from "@/lib/cache/keys";
import { emptyDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { DashboardClient } from "./dashboard-client";

const EMAIL = "linh.np@blended-asia.com";
const NOW = new Date("2026-08-15T08:00:00.000Z");

const TIMESHEET = {
  id: "file-1",
  name: "202608勤怠管理表",
  ownerEmail: "owner@blended-asia.com",
  month: "2026-08",
  modifiedTime: "2026-08-15T01:02:03.000Z",
  sheetId: "22",
  sheetTitle: "Linh",
  tabs: [{ sheetId: "22", title: "Linh" }],
};

function dashboardBody(timesheets: typeof TIMESHEET[] = [TIMESHEET]) {
  return { folder: null, managed: [], timesheets };
}

function monthView(overrides: Partial<AttendanceMonthView> = {}): AttendanceMonthView {
  return {
    fileId: "file-1",
    sheetId: 22,
    sheetTitle: "Linh",
    month: "2026-08",
    spreadsheetTimeZone: "Asia/Ho_Chi_Minh",
    role: "employee",
    statuses: [{ code: "office", labelEn: "Office", sheetValue: "出社" }],
    days: Array.from({ length: 31 }, (_, index) => {
      const day = emptyDay(`2026-08-${String(index + 1).padStart(2, "0")}`);
      return index === 2 ? { ...day, statusCode: "office", clockIn: 9, clockOut: 18 } : day;
    }),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // `sharedFetch` hands every caller its own clone, because a real body can
    // be read only once. This fake's `json` is re-readable, so the clone can be
    // the response itself — but the method has to exist.
    clone: () => response,
  };

  return response as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/dashboard")) return jsonResponse(200, dashboardBody());
    return jsonResponse(200, monthView());
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DashboardClient calendar workspace", () => {
  it("loads the current authorized timesheet into the dominant calendar", async () => {
    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(
      await screen.findByRole("grid", { name: "August 2026 attendance calendar" }),
    ).toBeVisible();
    // The grid is drawn from the month, so it is on screen before any data
    // arrives. The timesheet name is what proves the month actually loaded.
    expect(await screen.findByText("Linh")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Managed attendance files" })).toBeNull();
    // No shortcut rail beside the calendar: those destinations live in the
    // shell navigation, and repeating them cost the grid a third of the page.
    expect(screen.queryByLabelText("Calendar shortcuts")).toBeNull();
    expect(screen.queryByRole("link", { name: "All timesheets" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/file-1/attendance/22",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("opens a read-only day preview and links to full detail", async () => {
    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("gridcell", { name: /Monday, August 3, 2026.*Recorded/i }),
    );

    expect(screen.getByRole("dialog", { name: "Monday, August 3, 2026" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open full detail" })).toHaveAttribute(
      "href",
      "/files/file-1/attendance/22?date=2026-08-03",
    );
  });

  it("requires an explicit choice when the current month has duplicate candidates", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/dashboard")) {
        return jsonResponse(200, dashboardBody([
          TIMESHEET,
          { ...TIMESHEET, id: "file-2", name: "August backup", sheetId: "23", sheetTitle: "Linh backup" },
        ]));
      }
      return jsonResponse(200, monthView());
    });

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Choose a timesheet" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", {
      name: "Use 202608勤怠管理表 — Linh — owner@blended-asia.com",
    }));
    await screen.findByRole("grid", { name: "August 2026 attendance calendar" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows the approved empty state when the current month has no candidate", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(await screen.findByText("No timesheet for this month")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Timesheets" })).toHaveAttribute(
      "href",
      "/timesheets",
    );
  });

  it("can move from an empty current month to the nearest available earlier month", async () => {
    const julyTimesheet = {
      ...TIMESHEET,
      name: "202607勤怠管理表",
      month: "2026-07",
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/dashboard")) {
        return jsonResponse(200, dashboardBody([julyTimesheet]));
      }
      return jsonResponse(200, monthView({
        month: "2026-07",
        days: Array.from({ length: 31 }, (_, index) =>
          emptyDay(`2026-07-${String(index + 1).padStart(2, "0")}`),
        ),
      }));
    });

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    await screen.findByText("No timesheet for this month");
    const previousMonth = screen.getByRole("button", { name: "Previous month" });
    expect(previousMonth).toBeEnabled();

    fireEvent.click(previousMonth);

    expect(
      await screen.findByRole("grid", { name: "July 2026 attendance calendar" }),
    ).toBeVisible();
  });

  it("renders a compatible cached month before background revalidation finishes", async () => {
    const cache = createAttendanceCache({ engine: createMemoryEngine() });
    const context: CacheContext = {
      email: EMAIL,
      fileId: "file-1",
      sheetId: "22",
      month: "2026-08",
    };
    await cache.writeMonth(context, { view: monthView(), checkedAt: "2026-08-15T07:30:00.000Z" });

    let resolveRemote!: (response: Response) => void;
    const remote = new Promise<Response>((resolve) => {
      resolveRemote = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/dashboard")) return jsonResponse(200, dashboardBody());
      return remote;
    });

    render(<DashboardClient email={EMAIL} now={NOW} cache={cache} />);

    expect(
      await screen.findByRole("grid", { name: "August 2026 attendance calendar" }),
    ).toBeVisible();
    expect(await screen.findByText(/Showing cached data/i)).toBeVisible();

    resolveRemote(jsonResponse(200, monthView()));
    await waitFor(() => expect(screen.getByText(/Calendar refreshed/i)).toBeVisible());
  });

  it("disables Today and explains a missing spreadsheet timezone", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/dashboard")) return jsonResponse(200, dashboardBody());
      return jsonResponse(200, monthView({ spreadsheetTimeZone: null }));
    });

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(
      await screen.findByText(/spreadsheet timezone could not be determined/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
  });

  it("uses ErrorNotice so provider diagnostics are sanitized", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: "Could not load your dashboard.",
        debug: { name: "GoogleError", message: "safe", accessToken: "secret" },
      }),
    );

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your dashboard.");
    expect(document.body).not.toHaveTextContent("secret");
  });
});

describe("DashboardClient — the calendar is always drawn", () => {
  it("shows the month grid while nothing has loaded yet", () => {
    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    // Synchronously, before any fetch resolves.
    expect(screen.getByRole("grid", { name: "August 2026 attendance calendar" })).toBeVisible();
  });

  it("keeps the grid when no timesheet covers the month", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    expect(await screen.findByText("No timesheet for this month")).toBeVisible();
    expect(screen.getByRole("grid", { name: "August 2026 attendance calendar" })).toBeVisible();
    expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(28);
  });

  it("keeps the grid when the dashboard itself could not be loaded", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "Could not load your dashboard." }));

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    await screen.findByRole("alert");
    expect(screen.getByRole("grid", { name: "August 2026 attendance calendar" })).toBeVisible();
  });

  it("moves to any month, not only the ones that have a file", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    await screen.findByText("No timesheet for this month");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(
      await screen.findByRole("grid", { name: "September 2026 attendance calendar" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(
      await screen.findByRole("grid", { name: "July 2026 attendance calendar" }),
    ).toBeVisible();
  });
});

describe("DashboardClient — Sync sheet", () => {
  it("stays pressable on a month with no timesheet — that is when it is wanted", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    await screen.findByText("No timesheet for this month");
    expect(screen.getByRole("button", { name: "Sync sheet" })).toBeEnabled();
  });

  it("re-reads the listing and the month from Google Sheets on demand", async () => {
    render(
      <DashboardClient
        email={EMAIL}
        now={NOW}
        cache={createAttendanceCache({ engine: createMemoryEngine() })}
      />,
    );

    await screen.findByText("Linh");
    const before = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Sync sheet" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/file-1/attendance/22",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("stores the month it read, so the next open has it", async () => {
    const engine = createMemoryEngine();
    const cache = createAttendanceCache({ engine });
    const pointer = createCalendarPointerStore({ engine });

    render(<DashboardClient email={EMAIL} now={NOW} cache={cache} pointer={pointer} />);

    await screen.findByText("Linh");

    await waitFor(async () => {
      expect(await pointer.read(EMAIL)).toMatchObject({
        ok: true,
        value: { fileId: "file-1", sheetId: "22", month: "2026-08" },
      });
    });
  });
});

describe("DashboardClient — data already in this browser", () => {
  it("draws the stored month when discovery cannot name a file", async () => {
    const engine = createMemoryEngine();
    const cache = createAttendanceCache({ engine });
    const pointer = createCalendarPointerStore({ engine });
    const context: CacheContext = {
      email: EMAIL,
      fileId: "file-1",
      sheetId: "22",
      month: "2026-08",
    };

    await cache.writeMonth(context, { view: monthView(), checkedAt: "2026-08-15T07:30:00.000Z" });
    await pointer.write(context);

    // Discovery answers with nothing at all — offline, or the file stopped
    // being shared. The browser already holds the month.
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(<DashboardClient email={EMAIL} now={NOW} cache={cache} pointer={pointer} />);

    expect(await screen.findByText(/Showing this browser's copy/i)).toBeVisible();
    expect(
      screen.getByRole("gridcell", { name: /Monday, August 3, 2026.*Recorded/i }),
    ).toBeVisible();
  });

  it("does not draw a stored month onto a different month", async () => {
    const engine = createMemoryEngine();
    const cache = createAttendanceCache({ engine });
    const pointer = createCalendarPointerStore({ engine });
    const context: CacheContext = {
      email: EMAIL,
      fileId: "file-1",
      sheetId: "22",
      month: "2026-08",
    };

    await cache.writeMonth(context, { view: monthView(), checkedAt: "2026-08-15T07:30:00.000Z" });
    await pointer.write(context);
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody([])));

    render(<DashboardClient email={EMAIL} now={NOW} cache={cache} pointer={pointer} />);
    await screen.findByText(/Showing this browser's copy/i);

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));

    expect(
      await screen.findByRole("grid", { name: "September 2026 attendance calendar" }),
    ).toBeVisible();
    expect(screen.queryByText(/Showing this browser's copy/i)).toBeNull();
  });
});
