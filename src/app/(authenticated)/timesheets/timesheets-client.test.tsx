import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@/lib/dashboard/local-store";
import { TimesheetsClient } from "./timesheets-client";

const EMAIL = "linh.np@blended-asia.com";
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

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TimesheetsClient", () => {
  it("shows current timesheets, Open by link, and account-scoped recent files", async () => {
    const store = createMemoryStore();
    await store.addRecent(EMAIL, {
      fileId: "file-1",
      sheetId: "22",
      name: "August attendance",
      sheetTitle: "Linh",
      openedAt: "2026-08-15T02:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ folder: null, managed: [], timesheets: [TIMESHEET] }),
      ),
    );

    render(<TimesheetsClient email={EMAIL} store={store} />);

    expect(await screen.findByRole("heading", { name: "August 2026" })).toBeVisible();
    expect(screen.getByText("owner@blended-asia.com")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open timesheet" })).toHaveAttribute(
      "href",
      "/files/file-1/attendance/22",
    );
    fireEvent.click(screen.getByText("Open by link"));
    expect(screen.getByLabelText("Open by Google Sheets link")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Recently opened" })).toHaveTextContent(
      "August attendance",
    );
  });

  it("keeps an unmapped legacy timesheet behind an explicit tab choice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          folder: null,
          managed: [],
          timesheets: [{ ...TIMESHEET, sheetId: null, sheetTitle: null }],
        }),
      ),
    );

    render(<TimesheetsClient email={EMAIL} store={createMemoryStore()} />);

    expect(await screen.findByRole("link", { name: "Choose your tab" })).toHaveAttribute(
      "href",
      "/files/file-1/attendance",
    );
  });

  it("shows a focused empty state when no timesheet is authorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ folder: null, managed: [], timesheets: [] })),
    );

    render(<TimesheetsClient email={EMAIL} store={createMemoryStore()} />);

    expect(await screen.findByText("No timesheet for this month")).toBeVisible();
  });
});
