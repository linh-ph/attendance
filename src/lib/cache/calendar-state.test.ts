import { describe, expect, it } from "vitest";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import {
  buildCalendarPointer,
  buildCalendarSnapshot,
  isCalendarPointer,
  isCalendarSnapshot,
  summarizeCalendar,
  type CalendarSnapshot,
} from "./calendar-state";
import { CACHE_SCHEMA_VERSION } from "./keys";

const day = (date: string, over: Partial<AttendanceDay> = {}): AttendanceDay => ({
  ...emptyDay(date),
  ...over,
});

/** 2026-07-01 is a Wednesday; 2026-07-04 a Saturday; 2026-07-05 a Sunday. */
const view = (over: Partial<AttendanceMonthView> = {}): AttendanceMonthView => ({
  fileId: "file-1",
  sheetId: 101,
  sheetTitle: "Linh",
  month: "2026-07",
  spreadsheetTimeZone: "Asia/Tokyo",
  role: "employee",
  statuses: [],
  days: [
    day("2026-07-01", { clockIn: 9, clockOut: 18, breakHours: 1, workHours: 8 }),
    day("2026-07-02"),
    day("2026-07-03", { notes: "left early" }),
    day("2026-07-04"),
    day("2026-07-05"),
  ],
  ...over,
});

const snapshot = (over: Partial<CalendarSnapshot> = {}): CalendarSnapshot => ({
  ...buildCalendarSnapshot({
    email: "Linh.NP@Blended-Asia.com",
    view: view(),
    checkedAt: "2026-07-06T01:00:00.000Z",
  }),
  ...over,
});

describe("buildCalendarSnapshot", () => {
  it("records which month the calendar is on, scoped to the normalized account", () => {
    const built = snapshot();

    expect(built.month).toBe("2026-07");
    expect(built.account).toBe("linh.np@blended-asia.com");
    expect(built.fileId).toBe("file-1");
    expect(built.sheetId).toBe("101");
    expect(built.sheetTitle).toBe("Linh");
    expect(built.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(built.checkedAt).toBe("2026-07-06T01:00:00.000Z");
  });

  it("carries one state per day, in the order the month was read", () => {
    expect(snapshot().days.map((entry) => entry.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("derives Recorded and Not recorded from the domain rule, not from work hours alone", () => {
    const states = new Map(snapshot().days.map((entry) => [entry.date, entry.record]));

    expect(states.get("2026-07-01")).toBe("recorded");
    expect(states.get("2026-07-02")).toBe("not-recorded");
    // Notes alone are a carrier, and column H is not one.
    expect(states.get("2026-07-03")).toBe("recorded");
  });

  it("reports non-working days separately from whether the day is recorded", () => {
    const days = new Map(snapshot().days.map((entry) => [entry.date, entry]));

    expect(days.get("2026-07-01")?.nonWorking).toBeNull();
    expect(days.get("2026-07-04")?.nonWorking).toBe("weekend");
    expect(days.get("2026-07-05")?.nonWorking).toBe("weekend");
  });

  it("accepts a calendar context's own non-working dates", () => {
    const built = buildCalendarSnapshot({
      email: "linh.np@blended-asia.com",
      view: view(),
      checkedAt: "2026-07-06T01:00:00.000Z",
      nonWorkingDates: ["2026-07-02"],
    });

    expect(built.days.find((entry) => entry.date === "2026-07-02")?.nonWorking).toBe(
      "calendar-context",
    );
  });

  it("keeps the spreadsheet timezone, and treats a missing one as undeterminable", () => {
    expect(snapshot().spreadsheetTimeZone).toBe("Asia/Tokyo");
    expect(
      buildCalendarSnapshot({
        email: "a@b.com",
        view: view({ spreadsheetTimeZone: undefined }),
        checkedAt: "2026-07-06T01:00:00.000Z",
      }).spreadsheetTimeZone,
    ).toBeNull();
  });

  it("never stores the authorization role", () => {
    const built = snapshot() as unknown as Record<string, unknown>;

    expect(built.role).toBeUndefined();
    expect(JSON.stringify(built)).not.toContain("employee");
  });
});

describe("summarizeCalendar", () => {
  it("counts recorded days and the working days still empty", () => {
    expect(summarizeCalendar(snapshot())).toEqual({
      days: 5,
      recorded: 2,
      notRecorded: 3,
      workingDaysNotRecorded: 1,
    });
  });
});

describe("isCalendarSnapshot", () => {
  it("accepts what the builder produced", () => {
    expect(isCalendarSnapshot(snapshot())).toBe(true);
  });

  it("refuses a record carrying an authorization role", () => {
    expect(isCalendarSnapshot({ ...snapshot(), role: "manager" })).toBe(false);
  });

  it("refuses anything missing its scope, its days, or its last check", () => {
    expect(isCalendarSnapshot(null)).toBe(false);
    expect(isCalendarSnapshot({ ...snapshot(), month: "" })).toBe(false);
    expect(isCalendarSnapshot({ ...snapshot(), days: "many" })).toBe(false);
    expect(isCalendarSnapshot({ ...snapshot(), checkedAt: "" })).toBe(false);
    expect(isCalendarSnapshot({ ...snapshot(), schemaVersion: "1" })).toBe(false);
  });
});

describe("calendar pointer", () => {
  it("remembers the context the calendar was last showing", () => {
    const pointer = buildCalendarPointer({
      email: "Linh.NP@Blended-Asia.com",
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
      updatedAt: "2026-07-06T01:00:00.000Z",
    });

    expect(pointer.account).toBe("linh.np@blended-asia.com");
    expect(pointer.month).toBe("2026-07");
    expect(isCalendarPointer(pointer)).toBe(true);
  });

  it("refuses a pointer that is not one", () => {
    expect(isCalendarPointer({ account: "a@b.com" })).toBe(false);
    expect(isCalendarPointer(null)).toBe(false);
  });
});
