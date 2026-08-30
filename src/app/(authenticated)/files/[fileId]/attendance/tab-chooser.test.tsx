import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Timesheet } from "@/lib/discovery/file-discovery";
import { TabChooser } from "./tab-chooser";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The WebGL waiting state needs a GL context jsdom does not provide, and this
 * suite is about which tab gets opened, not about ghosts.
 */
vi.mock("@/components/loading-ghosts", () => ({
  LoadingGhosts: ({ label }: { label: string }) => <p>{label}</p>,
}));

const FILE_ID = "file-1";
const EMAIL = "linh.np@blended-asia.com";

const TABS = [
  { sheetId: "1468685976", title: "THAI GIA HAN" },
  { sheetId: "299837536", title: "NGUYEN PHAN LINH" },
  { sheetId: "448906253", title: "NGUYEN THI NHU HIEU" },
];

function timesheet(tabs: Timesheet["tabs"] = TABS): Timesheet {
  return {
    id: FILE_ID,
    name: "202608勤怠管理表",
    ownerEmail: null,
    month: "2026-08",
    modifiedTime: null,
    sheetId: null,
    sheetTitle: null,
    tabs,
  };
}

function stubDashboard(timesheets: Timesheet[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ timesheets }) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe("TabChooser", () => {
  test("goes straight to the tab the signed-in address names", async () => {
    stubDashboard([timesheet()]);

    render(<TabChooser fileId={FILE_ID} email={EMAIL} autoOpen />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/files/${FILE_ID}/attendance/299837536`),
    );
    expect(screen.getByText("Opening your timesheet…")).toBeDefined();
    expect(screen.queryByText("NGUYEN THI NHU HIEU")).toBeNull();
  });

  test("shows the list when the address names no tab", async () => {
    stubDashboard([timesheet()]);

    render(<TabChooser fileId={FILE_ID} email="someone.else@blended-asia.com" autoOpen />);

    await waitFor(() => expect(screen.getByText("NGUYEN PHAN LINH")).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
  });

  test("shows the list when two tabs answer to the same address", async () => {
    stubDashboard([
      timesheet([
        { sheetId: "1", title: "NGUYEN PHAN LINH" },
        { sheetId: "2", title: "NGO PHAM LINH" },
      ]),
    ]);

    render(<TabChooser fileId={FILE_ID} email={EMAIL} autoOpen />);

    await waitFor(() => expect(screen.getByText("NGO PHAM LINH")).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
  });

  test("shows the list regardless of any match when asked to", async () => {
    stubDashboard([timesheet()]);

    render(<TabChooser fileId={FILE_ID} email={EMAIL} autoOpen={false} />);

    await waitFor(() => expect(screen.getByText("NGUYEN PHAN LINH")).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
  });

  test("reports a file this account cannot reach instead of opening anything", async () => {
    stubDashboard([]);

    render(<TabChooser fileId={FILE_ID} email={EMAIL} autoOpen />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "You do not have permission to open this file, or it is not an attendance file.",
        ),
      ).toBeDefined(),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
