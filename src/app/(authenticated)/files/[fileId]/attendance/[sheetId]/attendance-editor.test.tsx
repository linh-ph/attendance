import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyDay, type AttendanceDay, type TimeSlot } from "@/lib/attendance/model";
import { createMemoryStore, createNullStore, type LocalStore } from "@/lib/dashboard/local-store";
import type {
  AttendanceMonthView,
  AttendancePatch,
  SaveAttendanceResult,
} from "@/lib/attendance/service";
import type { ConfigStatus } from "@/lib/config/schema";
import {
  AttendanceEditor,
  type AttendanceApiClient,
  type AttendanceApiError,
  type AttendanceSaveInput,
} from "./attendance-editor";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const EMAIL = "linh.np@blended-asia.com";
const FILE_ID = "file-1";
const SHEET_ID = "123";

const STATUSES: ConfigStatus[] = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
];

function monthDays(): AttendanceDay[] {
  return Array.from({ length: 31 }, (_, index) =>
    emptyDay(`2026-07-${String(index + 1).padStart(2, "0")}`),
  );
}

function monthView(overrides: Partial<AttendanceMonthView> = {}): AttendanceMonthView {
  return {
    fileId: FILE_ID,
    sheetId: Number(SHEET_ID),
    sheetTitle: "Linh",
    month: "2026-07",
    role: "employee",
    statuses: STATUSES,
    days: monthDays(),
    ...overrides,
  };
}

type DayOverrides = Partial<Omit<AttendanceDay, "slots">> & {
  slots?: Partial<Record<TimeSlot, string>>;
};

function mergeSlots(
  base: Record<TimeSlot, string>,
  overrides: Partial<Record<TimeSlot, string>> = {},
): Record<TimeSlot, string> {
  return Object.entries(overrides).reduce<Record<TimeSlot, string>>(
    (slots, [slot, value]) => (value === undefined ? slots : { ...slots, [slot]: value }),
    base,
  );
}

/** A month whose one interesting day carries the supplied baseline values. */
function viewWithDay(date: string, overrides: DayOverrides): AttendanceMonthView {
  const base = monthView();

  return {
    ...base,
    days: base.days.map((day) =>
      day.date === date
        ? { ...day, ...overrides, slots: mergeSlots(day.slots, overrides.slots) }
        : day,
    ),
  };
}

const SAVED: SaveAttendanceResult = { row: 18, workHours: null, written: [], conflicts: [] };

interface Harness {
  api: AttendanceApiClient;
  saveCalls: Array<AttendanceSaveInput & { fileId: string; sheetId: string }>;
  readCalls: number;
}

function createApi(
  options: {
    view?: AttendanceMonthView;
    onRead?: () => Promise<AttendanceMonthView>;
    onSave?: (input: AttendanceSaveInput) => Promise<SaveAttendanceResult>;
  } = {},
): Harness {
  const harness: Harness = {
    saveCalls: [],
    readCalls: 0,
    api: {
      async read(fileId, sheetId) {
        harness.readCalls += 1;
        if (options.onRead) return options.onRead();
        return { ...(options.view ?? monthView()), fileId, sheetId: Number(sheetId) };
      },
      async save(fileId, sheetId, input) {
        harness.saveCalls.push({ fileId, sheetId, ...input });
        return options.onSave ? options.onSave(input) : SAVED;
      },
    },
  };

  return harness;
}

function apiError(
  status: number,
  message: string,
  extra: Partial<AttendanceApiError> = {},
): AttendanceApiError {
  const error = new Error(message) as AttendanceApiError;
  error.status = status;
  return Object.assign(error, extra);
}

async function mount(
  harness: Harness,
  today = "2026-07-15",
  store: LocalStore = createMemoryStore(),
): Promise<LocalStore> {
  render(
    <AttendanceEditor
      fileId={FILE_ID}
      sheetId={SHEET_ID}
      email={EMAIL}
      store={store}
      api={harness.api}
      today={today}
    />,
  );
  await screen.findByRole("button", { name: "Save to Google Sheets" });
  return store;
}

function setSelect(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function applyBlock(start: string, end: string, description: string): void {
  setSelect("Start", start);
  setSelect("End", end);
  fireEvent.change(screen.getByLabelText("Work description"), { target: { value: description } });
  fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));
}

function save(): void {
  fireEvent.click(screen.getByRole("button", { name: "Save to Google Sheets" }));
}

function patchesOf(harness: Harness): AttendancePatch[] {
  return harness.saveCalls.flatMap((call) => call.patches);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("AttendanceEditor", () => {
  it("shows the whole English day surface for the loaded timesheet", async () => {
    await mount(createApi());

    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("Wednesday, July 15, 2026")).toBeInTheDocument();

    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Clock in")).toBeInTheDocument();
    expect(screen.getByLabelText("Clock out")).toBeInTheDocument();
    expect(screen.getByLabelText("Break hours")).toBeInTheDocument();
    expect(screen.getByLabelText("Work hours")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByLabelText("Lunch break · 12:00–13:00")).toBeInTheDocument();
    expect(screen.getByLabelText("06:00 work")).toBeInTheDocument();
    expect(screen.getByLabelText("23:30 work")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply work block" })).toBeInTheDocument();
  });

  it("prefers today when it falls inside the configured month", async () => {
    await mount(createApi(), "2026-07-06");

    expect(screen.getByText("Monday, July 6, 2026")).toBeInTheDocument();
  });

  it("falls back to the first day of the month when today is outside it", async () => {
    await mount(createApi(), "2027-01-05");

    expect(screen.getByText("Wednesday, July 1, 2026")).toBeInTheDocument();
  });

  it("labels a weekend day", async () => {
    await mount(createApi(), "2026-07-04");

    expect(screen.getByText("Saturday, July 4, 2026")).toBeInTheDocument();
    expect(screen.getByText("Weekend")).toBeInTheDocument();
  });

  it("moves to the next and previous day", async () => {
    await mount(createApi());

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(screen.getByText("Thursday, July 16, 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("Wednesday, July 15, 2026")).toBeInTheDocument();
  });

  it("writes a work block into every covered slot of the shared draft", async () => {
    await mount(createApi());

    applyBlock("09:00", "10:00", "Client report");

    expect(screen.getByLabelText("09:00 work")).toHaveValue("Client report");
    expect(screen.getByLabelText("09:30 work")).toHaveValue("Client report");
    expect(screen.getByLabelText("10:00 work")).toHaveValue("");
  });

  it("shows a timeline edit to the work-block editor before it applies", async () => {
    await mount(createApi());

    fireEvent.change(screen.getByLabelText("09:00 work"), { target: { value: "Standup" } });
    applyBlock("09:00", "10:00", "Client report");

    expect(screen.getByRole("alert")).toHaveTextContent("09:00");
    expect(screen.getByLabelText("09:00 work")).toHaveValue("Standup");

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("09:00 work")).toHaveValue("Client report");
  });

  it("sets the break to one hour and recalculates work hours when lunch is selected", async () => {
    await mount(createApi());

    setSelect("Clock in", "08:00");
    setSelect("Clock out", "17:30");
    expect(screen.getByLabelText("Work hours")).toHaveTextContent("9.5 hours");

    fireEvent.click(screen.getByLabelText("Lunch break · 12:00–13:00"));

    expect(screen.getByLabelText("Break hours")).toHaveValue(1);
    expect(screen.getByLabelText("Break hours")).toBeDisabled();
    expect(screen.getByLabelText("Work hours")).toHaveTextContent("8.5 hours");
    expect(screen.getByLabelText("12:00 work")).toBeDisabled();
    expect(screen.getByLabelText("12:30 work")).toBeDisabled();
  });

  it("clears reserved lunch text in the draft and only reaches Sheets on Save", async () => {
    const harness = createApi({
      view: viewWithDay("2026-07-15", { slots: { "12:00": "Standup" } }),
    });
    await mount(harness);

    expect(screen.getByLabelText("12:00 work")).toHaveValue("Standup");

    fireEvent.click(screen.getByLabelText("Lunch break · 12:00–13:00"));
    expect(screen.getByLabelText("12:00 work")).toHaveValue("");
    expect(harness.saveCalls).toEqual([]);

    save();
    await waitFor(() => expect(harness.saveCalls).toHaveLength(1));

    expect(patchesOf(harness)).toContainEqual({
      field: "slot",
      slot: "12:00",
      baseline: "Standup",
      value: "",
    });
  });

  it("skips the reserved lunch slots for a block that crosses them", async () => {
    await mount(createApi());

    fireEvent.click(screen.getByLabelText("Lunch break · 12:00–13:00"));
    applyBlock("11:30", "13:00", "Client report");

    expect(screen.getByLabelText("11:30 work")).toHaveValue("Client report");
    expect(screen.getByLabelText("12:00 work")).toHaveValue("");
    expect(screen.getByLabelText("12:30 work")).toHaveValue("");
  });

  it("re-enables the lunch slots and the break field when lunch is cleared", async () => {
    await mount(
      createApi({ view: viewWithDay("2026-07-15", { slots: { "12:00": "Standup" } }) }),
    );

    const lunch = screen.getByLabelText("Lunch break · 12:00–13:00");
    fireEvent.click(lunch);
    fireEvent.click(lunch);

    expect(screen.getByLabelText("12:00 work")).toBeEnabled();
    expect(screen.getByLabelText("12:30 work")).toBeEnabled();
    expect(screen.getByLabelText("Break hours")).toBeEnabled();
    expect(screen.getByLabelText("12:00 work")).toHaveValue("Standup");
  });

  it("refuses to save when clock out is not later than clock in", async () => {
    const harness = createApi();
    await mount(harness);

    setSelect("Clock in", "10:00");
    setSelect("Clock out", "09:00");
    save();

    expect(screen.getByText("Clock out must be later than clock in.")).toBeInTheDocument();
    expect(harness.saveCalls).toEqual([]);
  });

  it("refuses to save a break longer than the clocked duration", async () => {
    const harness = createApi();
    await mount(harness);

    setSelect("Clock in", "09:00");
    setSelect("Clock out", "10:00");
    fireEvent.change(screen.getByLabelText("Break hours"), { target: { value: "2" } });
    save();

    expect(
      screen.getByText("Break hours cannot be longer than the clocked duration."),
    ).toBeInTheDocument();
    expect(harness.saveCalls).toEqual([]);
  });

  it("refuses to save a negative break", async () => {
    const harness = createApi();
    await mount(harness);

    fireEvent.change(screen.getByLabelText("Break hours"), { target: { value: "-1" } });
    save();

    expect(screen.getByText("Break hours cannot be negative.")).toBeInTheDocument();
    expect(harness.saveCalls).toEqual([]);
  });

  it("sends only the dirty fields, each with its baseline", async () => {
    const harness = createApi({
      view: viewWithDay("2026-07-15", { notes: "Old note", clockIn: 8, clockOut: 17 }),
    });
    await mount(harness);

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    setSelect("Status", "office");
    save();

    await waitFor(() => expect(harness.saveCalls).toHaveLength(1));

    expect(harness.saveCalls[0].date).toBe("2026-07-15");
    expect(harness.saveCalls[0].patches).toEqual([
      { field: "status", baseline: null, value: "office" },
      { field: "notes", baseline: "Old note", value: "New note" },
    ]);
  });

  it("marks the day dirty and clears it only after a successful save", async () => {
    const harness = createApi();
    await mount(harness);

    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    save();
    await screen.findByText("Saved to Google Sheets.");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("keeps the unsaved edit and offers a retry when the save fails", async () => {
    let attempts = 0;
    const harness = createApi({
      onSave: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw apiError(502, "Google Sheets could not be reached. Try again.");
        }
        return SAVED;
      },
    });
    await mount(harness);

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    save();

    await screen.findByText("Google Sheets could not be reached. Try again.");
    expect(screen.getByLabelText("Notes")).toHaveValue("New note");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Saved to Google Sheets.");
    expect(harness.saveCalls).toHaveLength(2);
  });

  it("offers re-authentication when the Google session expired", async () => {
    const harness = createApi({
      onSave: async () => {
        throw apiError(401, "Your Google session expired.");
      },
    });
    await mount(harness);

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    save();

    await screen.findByText("Your Google session expired. Sign in again to continue.");
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
    expect(screen.getByLabelText("Notes")).toHaveValue("New note");
  });

  it("shows the server validation issues without discarding the draft", async () => {
    const harness = createApi({
      onSave: async () => {
        throw apiError(400, "Check the clock, break, and work-hour values.", {
          issues: [{ code: "clock-order" }],
        });
      },
    });
    await mount(harness);

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    save();

    await screen.findByText("Clock out must be later than clock in.");
    expect(screen.getByLabelText("Notes")).toHaveValue("New note");
  });

  it("discloses a last-writer conflict without undoing the saved value", async () => {
    const harness = createApi({
      view: viewWithDay("2026-07-15", { clockIn: 8, clockOut: 17 }),
      onSave: async () => ({
        ...SAVED,
        conflicts: [{ range: "E18", baseline: 8, current: 9 }],
      }),
    });
    await mount(harness);

    setSelect("Clock in", "08:30");
    save();

    await screen.findByText(
      "Clock in was changed to 09:00 by someone else; your value replaced it.",
    );
    expect(screen.getByLabelText("Clock in")).toHaveValue("08:30");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("warns before leaving a day that has unsaved changes", async () => {
    await mount(createApi());

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    setSelect("Day", "2026-07-20");

    expect(screen.getByText("You have unsaved changes on this day.")).toBeInTheDocument();
    expect(screen.getByText("Wednesday, July 15, 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByText("Monday, July 20, 2026")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveValue("");
  });

  it("keeps editing the same day when the navigation warning is dismissed", async () => {
    await mount(createApi());

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New note" } });
    setSelect("Day", "2026-07-20");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.getByText("Wednesday, July 15, 2026")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveValue("New note");
  });

  it("navigates freely once the day is clean", async () => {
    await mount(createApi());

    setSelect("Day", "2026-07-20");
    expect(screen.getByText("Monday, July 20, 2026")).toBeInTheDocument();
    expect(screen.queryByText("You have unsaved changes on this day.")).toBeNull();
  });

  it("reports a failed load and reloads on demand", async () => {
    let attempts = 0;
    const harness = createApi({
      onRead: async () => {
        attempts += 1;
        if (attempts === 1) throw apiError(502, "Google Sheets could not be reached. Try again.");
        return monthView();
      },
    });

    render(
      <AttendanceEditor
        fileId={FILE_ID}
        sheetId={SHEET_ID}
      email="linh.np@blended-asia.com"
        api={harness.api}
        today="2026-07-15"
      />,
    );

    await screen.findByText("Could not load this timesheet.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Save to Google Sheets" });
    expect(screen.getByText("Wednesday, July 15, 2026")).toBeInTheDocument();
  });

  it("does not send a save request when nothing is dirty", async () => {
    const harness = createApi();
    await mount(harness);

    save();

    expect(harness.saveCalls).toEqual([]);
    expect(screen.getByText("There are no changes to save.")).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Browser-local drafts                                                        */
/* -------------------------------------------------------------------------- */

describe("browser-local drafts", () => {
  it("keeps an unsaved day in local storage and clears it once it is saved", async () => {
    const harness = createApi();
    const store = await mount(harness);

    applyBlock("09:00", "12:00", "Spec work");

    await waitFor(async () =>
      expect(await store.readDraft(EMAIL, FILE_ID, SHEET_ID, "2026-07-15")).not.toBe(null),
    );

    save();

    await waitFor(async () =>
      expect(await store.readDraft(EMAIL, FILE_ID, SHEET_ID, "2026-07-15")).toBe(null),
    );
  });

  it("restores unsaved work after the editor is remounted", async () => {
    const store = createMemoryStore();
    await mount(createApi(), "2026-07-15", store);

    applyBlock("09:00", "12:00", "Spec work");
    await waitFor(async () =>
      expect(await store.readDraft(EMAIL, FILE_ID, SHEET_ID, "2026-07-15")).not.toBe(null),
    );

    cleanup();
    await mount(createApi(), "2026-07-15", store);

    await waitFor(() => expect(screen.getByLabelText("Work description")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save to Google Sheets" })).toBeEnabled(),
    );
  });

  it("drops a stored draft whose baseline no longer matches the sheet", async () => {
    const store = createMemoryStore();

    // A draft made against a row that no longer exists in the sheet as read.
    await store.writeDraft(EMAIL, FILE_ID, SHEET_ID, "2026-07-15", {
      day: { ...emptyDay("2026-07-15"), notes: "stale draft" },
      baseline: { ...emptyDay("2026-07-15"), notes: "someone else changed this" },
    });

    const harness = createApi();
    await mount(harness, "2026-07-15", store);

    // The stale note must never appear: the sheet moved on underneath it.
    await waitFor(() =>
      expect(screen.queryByDisplayValue("stale draft")).not.toBeInTheDocument(),
    );
  });

  it("works normally when the browser has no usable storage", async () => {
    const harness = createApi();
    await mount(harness, "2026-07-15", createNullStore());

    applyBlock("09:00", "12:00", "Spec work");
    save();

    await waitFor(() => expect(patchesOf(harness).length).toBeGreaterThan(0));
  });
});
