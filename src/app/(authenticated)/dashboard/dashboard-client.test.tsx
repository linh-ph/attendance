import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttendanceCache } from "@/lib/cache/attendance-cache";
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
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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
    expect(screen.getByText("Linh")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Managed attendance files" })).toBeNull();
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
    expect(screen.getByText(/Showing cached data/i)).toBeVisible();

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

    const today = await screen.findByRole("button", { name: "Today" });
    expect(today).toBeDisabled();
    expect(screen.getByText(/spreadsheet timezone could not be determined/i)).toBeVisible();
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
