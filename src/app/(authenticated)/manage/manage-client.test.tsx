import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folderPreferenceKey } from "@/lib/dashboard/folder-preference";
import { ManageClient } from "./manage-client";

const EMAIL = "manager@blended-asia.com";

const picker = vi.hoisted(() => ({
  folder: { id: "folder-1", name: "Attendance 2026" },
  spreadsheet: { id: "legacy-file", name: "202608勤怠管理表" },
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

const READY = {
  id: "ready-file",
  name: "202608勤怠管理表",
  ownerEmail: EMAIL,
  month: "2026-08",
  modifiedTime: "2026-08-20T09:00:00.000Z",
  memberCount: 4,
  setupState: "ready",
  error: null,
};

const LEGACY = {
  id: "legacy-file",
  name: "Legacy August",
  ownerEmail: EMAIL,
  month: "2026-08",
  modifiedTime: "2026-08-18T09:00:00.000Z",
  memberCount: null,
  setupState: "needs-setup",
  error: null,
};

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    folderPreferenceKey(EMAIL),
    JSON.stringify({ id: "folder-1", name: "Attendance 2026" }),
  );
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    response({ folder: { id: "folder-1", name: "Attendance 2026" }, managed: [READY, LEGACY], timesheets: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ManageClient", () => {
  it("shows the active folder and a scannable status table with one next action", async () => {
    render(<ManageClient email={EMAIL} />);

    expect(await screen.findByText("Attendance 2026")).toBeVisible();
    const readyRow = screen.getByRole("row", { name: /202608勤怠管理表/i });
    expect(readyRow).toHaveTextContent("Ready");
    expect(readyRow).toHaveTextContent("4 members");
    expect(within(readyRow).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/files/ready-file/members",
    );
    expect(screen.getByRole("link", { name: "Create monthly file" })).toHaveAttribute(
      "href",
      "/files/new",
    );
    expect(screen.getByRole("link", { name: "Import XLSX" })).toHaveAttribute(
      "href",
      "/files/import",
    );
  });

  it("filters rows without changing the server discovery request", async () => {
    render(<ManageClient email={EMAIL} />);
    await screen.findByRole("row", { name: /202608勤怠管理表/i });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search managed files" }), {
      target: { value: "Legacy" },
    });

    expect(screen.queryByRole("row", { name: /202608勤怠管理表/i })).toBeNull();
    expect(screen.getByRole("row", { name: /Legacy August/i })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires Picker confirmation before a retained file can resume setup", async () => {
    render(<ManageClient email={EMAIL} />);
    const row = await screen.findByRole("row", { name: /Legacy August/i });

    expect(within(row).queryByRole("link", { name: "Resume" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Confirm file" }));
    await waitFor(() =>
      expect(within(row).getByRole("link", { name: "Resume" })).toHaveAttribute(
        "href",
        "/files/legacy-file/setup",
      ),
    );
  });

  it("asks for a folder when no account-scoped preference exists", async () => {
    window.localStorage.clear();
    fetchMock.mockResolvedValue(response({ folder: null, managed: [], timesheets: [] }));

    render(<ManageClient email={EMAIL} />);

    expect(await screen.findByRole("button", { name: "Select folder" })).toBeVisible();
    expect(screen.getByText("Choose a folder to see managed attendance files.")).toBeVisible();
  });
});
