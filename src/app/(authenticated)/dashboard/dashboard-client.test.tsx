import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { folderPreferenceKey } from "@/lib/dashboard/folder-preference";
import { DashboardClient } from "./dashboard-client";

const EMAIL = "manager@blended-asia.com";
const PREFERENCE_KEY = folderPreferenceKey(EMAIL);

/** Mutable Picker results; `vi.hoisted` keeps them reachable from the mock factory. */
const picker = vi.hoisted(() => ({
  folder: { id: "folder-1", name: "Attendance 2026" },
  spreadsheet: { id: "legacy-file", name: "202605勤怠管理表" },
}));

vi.mock("@/components/google-picker", () => ({
  GooglePicker: ({
    mode,
    label,
    onSelect,
  }: {
    mode: "folder" | "spreadsheet";
    label: string;
    onSelect: (item: { id: string; name: string }) => void;
  }) => (
    <button type="button" data-mode={mode} onClick={() => onSelect(picker[mode])}>
      {label}
    </button>
  ),
}));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const READY_FILE = {
  id: "ready-file",
  name: "202607勤怠管理表",
  ownerEmail: EMAIL,
  month: "2026-07",
  modifiedTime: "2026-07-30T09:05:00.000Z",
  memberCount: 2,
  setupState: "ready",
  error: null,
};

const LEGACY_FILE = {
  id: "legacy-file",
  name: "202605勤怠管理表",
  ownerEmail: EMAIL,
  month: null,
  modifiedTime: "2026-05-30T09:00:00.000Z",
  memberCount: null,
  setupState: "needs-setup",
  error: null,
};

const TIMESHEET = {
  id: "shared-file",
  name: "202607勤怠管理表",
  ownerEmail: "owner@blended-asia.com",
  month: "2026-07",
  modifiedTime: "2026-07-29T01:02:03.000Z",
  sheetId: "222",
  sheetTitle: "Manager",
  tabs: [{ sheetId: "222", title: "Manager" }],
};

function dashboardBody(overrides: Record<string, unknown> = {}) {
  return {
    folder: { id: "folder-1", name: "Attendance 2026" },
    managed: [READY_FILE, LEGACY_FILE],
    timesheets: [TIMESHEET],
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

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function storePreference(id = "folder-1", name = "Attendance 2026"): void {
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ id, name }));
}

/* -------------------------------------------------------------------------- */
/* Sections and folder control                                                 */
/* -------------------------------------------------------------------------- */

describe("DashboardClient — sections", () => {
  it("renders both role-aware sections", async () => {
    render(<DashboardClient email={EMAIL} />);

    expect(
      await screen.findByRole("heading", { name: "Managed attendance files" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "My timesheets" })).toBeVisible();
  });

  it("asks for a folder and never sends one when nothing is remembered", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, dashboardBody({ folder: null, managed: [] })),
    );

    render(<DashboardClient email={EMAIL} />);

    expect(await screen.findByRole("button", { name: "Select dashboard folder" })).toBeVisible();
    expect(requestedUrls()).toEqual(["/api/dashboard"]);
    expect(
      screen.getByText("Select a dashboard folder to see the attendance files you manage."),
    ).toBeVisible();
  });

  it("revalidates the remembered folder and shows its name with a change action", async () => {
    storePreference();

    render(<DashboardClient email={EMAIL} />);

    await screen.findByRole("button", { name: "Change folder" });
    expect(requestedUrls()).toEqual(["/api/dashboard?folderId=folder-1"]);
    expect(screen.getByText("Attendance 2026")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Select dashboard folder" })).toBeNull();
  });

  it("replaces the remembered folder and reloads when a new folder is picked", async () => {
    storePreference("folder-old", "Old folder");
    picker.folder = { id: "folder-new", name: "New folder" };

    render(<DashboardClient email={EMAIL} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change folder" }));

    await waitFor(() =>
      expect(requestedUrls()).toEqual([
        "/api/dashboard?folderId=folder-old",
        "/api/dashboard?folderId=folder-new",
      ]),
    );
    expect(JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? "null")).toEqual({
      id: "folder-new",
      name: "New folder",
    });

    picker.folder = { id: "folder-1", name: "Attendance 2026" };
  });
});

/* -------------------------------------------------------------------------- */
/* Manager cards                                                               */
/* -------------------------------------------------------------------------- */

describe("DashboardClient — managed cards", () => {
  it("shows the full ready card and only the permitted manager actions", async () => {
    storePreference();

    render(<DashboardClient email={EMAIL} />);

    const card = await screen.findByRole("listitem", { name: "202607勤怠管理表" });
    const card_ = within(card);

    expect(card_.getByText("July 2026")).toBeVisible();
    expect(card_.getByText(EMAIL)).toBeVisible();
    expect(card_.getByText("2 members")).toBeVisible();
    expect(card_.getByText("Jul 30, 2026, 09:05 UTC")).toBeVisible();
    expect(card_.getByText("Ready")).toBeVisible();

    expect(card_.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/files/ready-file/members",
    );
    expect(card_.getByRole("link", { name: "Manage members" })).toHaveAttribute(
      "href",
      "/files/ready-file/members#add-member",
    );
    expect(card_.getByRole("link", { name: "Open in Google Sheets" })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/ready-file/edit",
    );
  });

  it("keeps a needs-setup file read-only until the picker confirms the same file", async () => {
    storePreference();

    render(<DashboardClient email={EMAIL} />);

    const card = within(await screen.findByRole("listitem", { name: "202605勤怠管理表" }));
    expect(card.getByText("Needs setup")).toBeVisible();
    expect(card.queryByRole("link", { name: "Open" })).toBeNull();
    expect(card.queryByRole("link", { name: "Manage members" })).toBeNull();
    expect(card.queryByRole("link", { name: "Continue setup" })).toBeNull();
    expect(card.getByRole("button", { name: "Set up" })).toHaveAttribute(
      "data-mode",
      "spreadsheet",
    );
  });

  it("reveals the setup link only after the same file is selected in the picker", async () => {
    storePreference();
    picker.spreadsheet = { id: "legacy-file", name: "202605勤怠管理表" };

    render(<DashboardClient email={EMAIL} />);

    const card = within(await screen.findByRole("listitem", { name: "202605勤怠管理表" }));
    fireEvent.click(card.getByRole("button", { name: "Set up" }));

    expect(await card.findByRole("link", { name: "Continue setup" })).toHaveAttribute(
      "href",
      "/files/legacy-file/setup",
    );
  });

  it("refuses a picker selection that is another file this manager does manage", async () => {
    storePreference();
    picker.spreadsheet = { id: "ready-file", name: "202607勤怠管理表" };

    render(<DashboardClient email={EMAIL} />);

    const card = within(await screen.findByRole("listitem", { name: "202605勤怠管理表" }));
    fireEvent.click(card.getByRole("button", { name: "Set up" }));

    expect(
      await card.findByText("Select this same file in Google Picker to start setup."),
    ).toBeVisible();
    expect(card.queryByRole("link", { name: "Continue setup" })).toBeNull();

    picker.spreadsheet = { id: "legacy-file", name: "202605勤怠管理表" };
  });

  it("reports a permission problem when the picked file is not one this manager can set up", async () => {
    storePreference();
    picker.spreadsheet = { id: "another-file", name: "Another workbook" };

    render(<DashboardClient email={EMAIL} />);

    const card = within(await screen.findByRole("listitem", { name: "202605勤怠管理表" }));
    fireEvent.click(card.getByRole("button", { name: "Set up" }));

    expect(
      await card.findByText(
        "You do not have permission to set up that file. Pick a file you own from this folder.",
      ),
    ).toBeVisible();
    expect(card.queryByRole("link", { name: "Continue setup" })).toBeNull();

    picker.spreadsheet = { id: "legacy-file", name: "202605勤怠管理表" };
  });

  it("shows a card-level error without offering managed actions", async () => {
    storePreference();
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        dashboardBody({
          managed: [
            {
              ...READY_FILE,
              setupState: "unknown",
              memberCount: null,
              error: "Could not read this file's attendance configuration.",
            },
          ],
        }),
      ),
    );

    render(<DashboardClient email={EMAIL} />);

    const card = within(await screen.findByRole("listitem", { name: "202607勤怠管理表" }));
    expect(
      card.getByText("Could not read this file's attendance configuration."),
    ).toBeVisible();
    expect(card.queryByRole("link", { name: "Open" })).toBeNull();
    expect(card.getByRole("link", { name: "Open in Google Sheets" })).toBeVisible();
  });

  it("shows an empty state when the selected folder holds no attendance files", async () => {
    storePreference();
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody({ managed: [] })));

    render(<DashboardClient email={EMAIL} />);

    expect(
      await screen.findByText("No attendance files in this folder."),
    ).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/* Employee cards                                                              */
/* -------------------------------------------------------------------------- */

describe("DashboardClient — timesheets", () => {
  it("links directly to the mapped numeric sheet id", async () => {
    render(<DashboardClient email={EMAIL} />);

    const card = within(
      await screen.findByRole("listitem", {
        name: "202607勤怠管理表 — Manager — owner@blended-asia.com",
      }),
    );

    expect(card.getByRole("link", { name: "Open timesheet" })).toHaveAttribute(
      "href",
      "/files/shared-file/attendance/222",
    );
    expect(card.getByText("Manager")).toBeVisible();
    expect(card.getByText("owner@blended-asia.com")).toBeVisible();
    expect(card.getByText("July 2026")).toBeVisible();
  });

  it("shows an empty state when no timesheet is shared", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, dashboardBody({ timesheets: [] })));

    render(<DashboardClient email={EMAIL} />);

    expect(await screen.findByText("No timesheets are shared with you yet.")).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/* Folder failure                                                              */
/* -------------------------------------------------------------------------- */

describe("DashboardClient — unavailable folder", () => {
  it.each([404, 403, 422])(
    "shows Folder unavailable for %i and clears the preference only afterwards",
    async (status) => {
      storePreference();

      const clearedWhileShowing: boolean[] = [];
      const originalRemove = Storage.prototype.removeItem;
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        clearedWhileShowing.push(
          (document.body.textContent ?? "").includes("Folder unavailable"),
        );
        originalRemove.call(this, key);
      });

      fetchMock.mockResolvedValue(
        jsonResponse(status, {
          folder: null,
          managed: [],
          timesheets: [TIMESHEET],
          folderError: "Folder unavailable.",
        }),
      );

      render(<DashboardClient email={EMAIL} />);

      expect(await screen.findByText("Folder unavailable.")).toBeVisible();
      await waitFor(() => expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull());
      expect(clearedWhileShowing).toContain(true);
      expect(clearedWhileShowing).not.toContain(false);

      // A new selection is required, and the employee section is unaffected.
      expect(screen.getByRole("button", { name: "Select dashboard folder" })).toBeVisible();
      expect(screen.getByRole("link", { name: "Open timesheet" })).toBeVisible();
    },
  );

  it("asks the user to sign in again when the session expired", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "Authentication required." }));

    render(<DashboardClient email={EMAIL} />);

    expect(
      await screen.findByText("Your Google session expired. Sign in again to continue."),
    ).toBeVisible();
  });

  it("shows a retryable error when the dashboard cannot be loaded", async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, { error: "Could not load your dashboard." }));

    render(<DashboardClient email={EMAIL} />);

    expect(await screen.findByText("Could not load your dashboard.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByLabelText("Debug error details")).toBeNull();
  });

  it("shows sanitized debug details returned by the dashboard API", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(502, {
        error: "Could not load your dashboard.",
        debug: {
          name: "GoogleApiError",
          message: "Google request failed: files.list shared candidates.",
          status: 403,
          providerMessage: "Google Drive API is disabled.",
          providerStatus: "PERMISSION_DENIED",
          providerReason: "accessNotConfigured",
        },
      }),
    );

    render(<DashboardClient email={EMAIL} />);

    expect(await screen.findByText("Could not load your dashboard.")).toBeVisible();
    expect(screen.getByLabelText("Debug error details")).toHaveTextContent(
      "Google request failed: files.list shared candidates.",
    );
    expect(screen.getByLabelText("Debug error details")).toHaveTextContent(
      "Google Drive API is disabled.",
    );
    expect(screen.getByLabelText("Debug error details")).toHaveTextContent(
      "PERMISSION_DENIED",
    );
    expect(screen.getByLabelText("Debug error details")).toHaveTextContent(
      "accessNotConfigured",
    );
  });
});
