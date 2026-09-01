import { describe, expect, it } from "vitest";
import { dayRecordState, isNonWorkingDay, nonWorkingDaySource } from "./day-state";
import { emptyDay, type AttendanceDay } from "./model";

const DATE = "2026-07-15"; // A Wednesday.

function day(overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay(DATE), ...overrides };
}

describe("dayRecordState", () => {
  it("reports an untouched day as not recorded", () => {
    expect(dayRecordState(emptyDay(DATE))).toBe("not-recorded");
  });

  /*
   * The work report decides. Each case sets exactly one field on an otherwise
   * empty day, so nothing can be carried by another.
   */

  /**
   * The template fills these on every working day of the month before anybody
   * touches it — measured on the real workbook, all 21 of August's working days
   * carried an identical `office / 08:00 / 17:00 / 1`. Counting them marked a
   * day recorded that nobody had filled in.
   */
  it("is not recorded from the values the monthly template pre-fills", () => {
    expect(dayRecordState(day({ statusCode: "office" }))).toBe("not-recorded");
    expect(dayRecordState(day({ clockIn: 8 }))).toBe("not-recorded");
    expect(dayRecordState(day({ clockOut: 17 }))).toBe("not-recorded");
    expect(dayRecordState(day({ breakHours: 1 }))).toBe("not-recorded");
  });

  it("is not recorded for a whole template-filled day with an empty work report", () => {
    // This is exactly 2026-08-31 in the owner's workbook.
    expect(
      dayRecordState(day({ statusCode: "office", clockIn: 8, clockOut: 17, breakHours: 1 })),
    ).toBe("not-recorded");
  });

  it("is recorded when the status answers the day on its own", () => {
    // Somebody absent has nothing to report; an empty work report is correct.
    expect(dayRecordState(day({ statusCode: "absent" }))).toBe("recorded");
  });

  it("is recorded when only notes are set", () => {
    expect(dayRecordState(day({ notes: "Left early" }))).toBe("recorded");
  });

  it("is recorded when only a work-report slot is set", () => {
    const base = emptyDay(DATE);
    expect(dayRecordState(day({ slots: { ...base.slots, "14:30": "Design review" } }))).toBe(
      "recorded",
    );
  });

  it("is recorded from any single work-report slot, including the first and last", () => {
    const base = emptyDay(DATE);

    expect(dayRecordState(day({ slots: { ...base.slots, "06:00": "x" } }))).toBe("recorded");
    expect(dayRecordState(day({ slots: { ...base.slots, "23:30": "x" } }))).toBe("recorded");
  });

  it("treats a zero break as no break", () => {
    expect(dayRecordState(day({ breakHours: 0 }))).toBe("not-recorded");
  });

  it("treats whitespace-only notes and slots as empty", () => {
    const base = emptyDay(DATE);

    expect(dayRecordState(day({ notes: "   " }))).toBe("not-recorded");
    expect(dayRecordState(day({ slots: { ...base.slots, "10:00": "  " } }))).toBe("not-recorded");
  });

  it("never counts the derived column-H work hours as a carrier", () => {
    // Column H is the `=F-G-E` formula and is never written by a save; a value
    // read back from it must not make an otherwise empty day look recorded.
    expect(dayRecordState(day({ workHours: 0 }))).toBe("not-recorded");
    expect(dayRecordState(day({ workHours: 8 }))).toBe("not-recorded");
  });

  it("never counts the inferred lunch-break flag as a carrier on its own", () => {
    expect(dayRecordState(day({ lunchBreak: true }))).toBe("not-recorded");
  });

  it("does not add a Complete state to the vocabulary", () => {
    const states = new Set(
      [
        emptyDay(DATE),
        day({ statusCode: "office", clockIn: 9, clockOut: 18, breakHours: 1, notes: "Full day" }),
      ].map(dayRecordState),
    );

    expect([...states].sort()).toEqual(["not-recorded", "recorded"]);
  });
});

describe("nonWorkingDaySource", () => {
  it("reports a Saturday and a Sunday as weekend", () => {
    expect(nonWorkingDaySource("2026-07-18")).toBe("weekend");
    expect(nonWorkingDaySource("2026-07-19")).toBe("weekend");
  });

  it("reports an ordinary weekday as working", () => {
    expect(nonWorkingDaySource("2026-07-15")).toBeNull();
    expect(isNonWorkingDay("2026-07-15")).toBe(false);
  });

  it("reports a weekday supplied by the calendar context as a context non-working day", () => {
    const context = { nonWorkingDates: ["2026-07-15"] };

    expect(nonWorkingDaySource("2026-07-15", context)).toBe("calendar-context");
    expect(isNonWorkingDay("2026-07-15", context)).toBe(true);
  });

  it("prefers the weekend source when the context also lists the same date", () => {
    expect(nonWorkingDaySource("2026-07-18", { nonWorkingDates: ["2026-07-18"] })).toBe("weekend");
  });

  it("honours a context that redefines which weekdays are the weekend", () => {
    // Friday/Saturday weekends exist; the calendar context decides, not the code.
    const context = { weekendDays: [5, 6] };

    expect(nonWorkingDaySource("2026-07-17", context)).toBe("weekend"); // Friday
    expect(nonWorkingDaySource("2026-07-19", context)).toBeNull(); // Sunday
  });

  it("does not use the device timezone to decide the weekday", () => {
    // Vitest pins TZ=America/Los_Angeles. A UTC-midnight `Date` would land on
    // the previous day there and misreport this Sunday as a Saturday.
    expect(nonWorkingDaySource("2026-07-05")).toBe("weekend");
    expect(nonWorkingDaySource("2026-07-06")).toBeNull();
  });

  it("returns null for a string that is not a calendar date", () => {
    expect(nonWorkingDaySource("not-a-date")).toBeNull();
    expect(nonWorkingDaySource("2026-07-32")).toBeNull();
  });
});
