import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView, SaveAttendanceResult } from "@/lib/attendance/service";
import type { ConfigStatus } from "@/lib/config/schema";
import { BulkApplyPanel } from "./bulk-apply-panel";
import type { AttendanceApiClient, AttendanceSaveInput } from "./attendance-api";

const FILE_ID = "file-1";
const SHEET_ID = "101";

const STATUSES: ConfigStatus[] = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
];

/** 2026-07-01 is a Wednesday, so the 4th and 5th are the weekend. */
function day(date: string, overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay(date), ...overrides };
}

const SOURCE = day("2026-07-01", {
  statusCode: "office",
  clockIn: 8,
  clockOut: 17,
  breakHours: 1,
  notes: "Sprint work",
});

function view(days: AttendanceDay[]): AttendanceMonthView {
  return {
    fileId: FILE_ID,
    sheetId: Number(SHEET_ID),
    sheetTitle: "NGUYEN PHAN LINH",
    month: "2026-07",
    role: "open",
    statuses: STATUSES,
    days,
  };
}

function monthDays(overrides: Record<string, Partial<AttendanceDay>> = {}): AttendanceDay[] {
  return Array.from({ length: 31 }, (_, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
    return date === SOURCE.date ? SOURCE : day(date, overrides[date] ?? {});
  });
}

interface Harness {
  api: AttendanceApiClient;
  saves: { date: string; input: AttendanceSaveInput }[];
  onApplied: () => void;
}

function createHarness(onSave?: (date: string) => void): Harness {
  const saves: Harness["saves"] = [];

  return {
    saves,
    onApplied: vi.fn<() => void>(),
    api: {
      read: async () => view(monthDays()),
      save: async (_fileId, _sheetId, input) => {
        onSave?.(input.date);
        saves.push({ date: input.date, input });
        return { row: 4, workHours: 8, written: [], conflicts: [] } satisfies SaveAttendanceResult;
      },
    },
  };
}

function renderPanel(harness: Harness, days = monthDays()) {
  render(
    <BulkApplyPanel
      fileId={FILE_ID}
      sheetId={SHEET_ID}
      view={view(days)}
      source={SOURCE}
      api={harness.api}
      onApplied={harness.onApplied}
    />,
  );
}

/** The calendar renders a button per day; the label is the day number. */
function clickDay(dayNumber: number): void {
  const cell = screen
    .getAllByRole("button")
    .find((button) => button.textContent?.trim() === String(dayNumber));

  expect(cell).toBeDefined();
  fireEvent.click(cell as HTMLElement);
}

function open(): void {
  fireEvent.click(screen.getByRole("button", { name: "Apply this day to other days" }));
}

describe("BulkApplyPanel", () => {
  it("stays out of the way until it is opened", () => {
    renderPanel(createHarness());

    expect(screen.getByRole("button", { name: "Apply this day to other days" })).toBeVisible();
    expect(screen.queryByText("No days chosen.")).toBeNull();
  });

  it("writes one day per chosen date, through the ordinary save endpoint", async () => {
    const harness = createHarness();
    renderPanel(harness);
    open();

    clickDay(2);
    clickDay(3);

    expect(screen.getByText("2 days chosen.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 days" }));

    await waitFor(() => expect(harness.saves).toHaveLength(2));
    expect(harness.saves.map((save) => save.date)).toEqual(["2026-07-02", "2026-07-03"]);
    expect(harness.onApplied).toHaveBeenCalled();
  });

  it("sends the source day's own values, under each target's date", async () => {
    const harness = createHarness();
    renderPanel(harness);
    open();
    clickDay(2);

    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 day" }));

    await waitFor(() => expect(harness.saves).toHaveLength(1));
    const fields = harness.saves[0].input.patches.map((patch) => patch.field);
    expect(fields).toEqual(expect.arrayContaining(["status", "clockIn", "clockOut", "notes"]));
    // Column H holds the `=F-G-E` formula and is never written.
    expect(fields).not.toContain("workHours");
  });

  /*
   * Applying replaces; it never merges. The days that already hold something
   * are named before anything is written, so nobody discovers the replacement
   * afterwards.
   */
  it("names the days it would overwrite, before anything is written", () => {
    const harness = createHarness();
    renderPanel(harness, monthDays({ "2026-07-03": { notes: "Already here" } }));
    open();

    clickDay(2);
    expect(screen.queryByRole("alert")).toBeNull();

    clickDay(3);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Replacing what is already recorded on 1 of them: 2026-07-03.",
    );
    expect(harness.saves).toHaveLength(0);
  });

  it("refuses to apply with nothing chosen", async () => {
    const harness = createHarness();
    renderPanel(harness);
    open();

    fireEvent.click(screen.getByRole("button", { name: "Apply to 0 days" }));

    await screen.findByText("Choose at least one day to apply this to.");
    expect(harness.saves).toHaveLength(0);
  });

  it("never offers the day being copied as a target", () => {
    renderPanel(createHarness());
    open();

    const source = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.trim() === "1");

    expect(source).toBeDisabled();
  });

  /*
   * A run that fails part-way has already written real days. Reporting it as a
   * whole failure would be a lie, and reporting success would be worse.
   */
  it("stops at the day that failed and says how many were written", async () => {
    const harness = createHarness((date) => {
      if (date === "2026-07-03") throw new Error("Google Sheets could not be reached.");
    });
    renderPanel(harness);
    open();

    clickDay(2);
    clickDay(3);
    clickDay(6);

    fireEvent.click(screen.getByRole("button", { name: "Apply to 3 days" }));

    await screen.findByText(
      "Google Sheets could not be reached. 1 of 3 days were written.",
    );
    expect(harness.saves.map((save) => save.date)).toEqual(["2026-07-02"]);
    // The month is reloaded even on failure: real days were written.
    expect(harness.onApplied).toHaveBeenCalled();
  });
});
