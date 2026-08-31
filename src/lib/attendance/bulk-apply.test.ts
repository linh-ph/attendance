import { describe, expect, it } from "vitest";
import { emptyDay, type AttendanceDay } from "./model";
import { copyDayOnto, datesInRange, hasEntry, toggleDate } from "./bulk-apply";

/** 2026-07: the 1st is a Wednesday, so the 4th and 5th are the weekend. */
function day(date: string, overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay(date), ...overrides };
}

const SOURCE = day("2026-07-01", {
  statusCode: "office",
  clockIn: 8,
  clockOut: 17,
  breakHours: 1,
  lunchBreak: true,
  workHours: 8,
  notes: "Sprint work",
  slots: { ...emptyDay("2026-07-01").slots, "09:00": "Standup", "09:30": "Standup" },
});

describe("datesInRange", () => {
  it("returns every weekday between the two ends, inclusive", () => {
    expect(datesInRange("2026-07-01", "2026-07-08")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  it("leaves the weekend out — dragging across a week is a working-week gesture", () => {
    expect(datesInRange("2026-07-04", "2026-07-05")).toEqual([]);
  });

  it("reads the same in either direction, so dragging backwards works", () => {
    expect(datesInRange("2026-07-08", "2026-07-06")).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  it("returns the one day when both ends are the same weekday", () => {
    expect(datesInRange("2026-07-02", "2026-07-02")).toEqual(["2026-07-02"]);
  });

  it("refuses a date that is not a calendar day", () => {
    expect(datesInRange("2026-07-32", "2026-07-02")).toEqual([]);
  });
});

describe("toggleDate", () => {
  it("adds a date and keeps the list in calendar order", () => {
    expect(toggleDate(["2026-07-08", "2026-07-02"], "2026-07-06")).toEqual([
      "2026-07-02",
      "2026-07-06",
      "2026-07-08",
    ]);
  });

  it("removes a date that is already chosen", () => {
    expect(toggleDate(["2026-07-02", "2026-07-06"], "2026-07-02")).toEqual(["2026-07-06"]);
  });

  /*
   * A weekend is never selected by a drag, but a single click on one is an
   * explicit choice — somebody who worked a Saturday says so by clicking it.
   */
  it("accepts a weekend picked by hand", () => {
    expect(toggleDate([], "2026-07-04")).toEqual(["2026-07-04"]);
  });

  it("never mutates the list it is given", () => {
    const before = ["2026-07-02"];
    toggleDate(before, "2026-07-03");
    expect(before).toEqual(["2026-07-02"]);
  });
});

describe("hasEntry", () => {
  it("is false for a day the sheet holds nothing for", () => {
    expect(hasEntry(day("2026-07-02"))).toBe(false);
  });

  it.each([
    ["a status", { statusCode: "office" as const }],
    ["a clock in", { clockIn: 9 }],
    ["a clock out", { clockOut: 18 }],
    ["a break", { breakHours: 1 }],
    ["a note", { notes: "Anything" }],
  ])("is true for a day carrying %s", (_case, overrides) => {
    expect(hasEntry(day("2026-07-02", overrides))).toBe(true);
  });

  it("is true for a day carrying only work-report text", () => {
    const slots = { ...emptyDay("2026-07-02").slots, "14:00": "Review" };
    expect(hasEntry(day("2026-07-02", { slots }))).toBe(true);
  });
});

describe("copyDayOnto", () => {
  it("carries the whole entry across, under the target's own date", () => {
    const copied = copyDayOnto(SOURCE, day("2026-07-02"));

    expect(copied.date).toBe("2026-07-02");
    expect(copied.statusCode).toBe("office");
    expect(copied.clockIn).toBe(8);
    expect(copied.clockOut).toBe(17);
    expect(copied.breakHours).toBe(1);
    expect(copied.lunchBreak).toBe(true);
    expect(copied.notes).toBe("Sprint work");
    expect(copied.slots["09:00"]).toBe("Standup");
  });

  /*
   * Column H holds the `=F-G-E` formula and is never written by a save, so the
   * copy must not carry a work-hours number of its own onto the target.
   */
  it("leaves the target's own work hours alone", () => {
    const target = day("2026-07-02", { workHours: 4 });

    expect(copyDayOnto(SOURCE, target).workHours).toBe(4);
  });

  it("replaces the target's entry rather than merging with it", () => {
    const target = day("2026-07-02", {
      statusCode: "absent",
      clockIn: 10,
      notes: "Old note",
      slots: { ...emptyDay("2026-07-02").slots, "20:00": "Old text" },
    });

    const copied = copyDayOnto(SOURCE, target);

    expect(copied.statusCode).toBe("office");
    expect(copied.clockIn).toBe(8);
    expect(copied.notes).toBe("Sprint work");
    expect(copied.slots["20:00"]).toBe("");
  });

  it("never mutates either day it is given", () => {
    const target = day("2026-07-02", { notes: "Old note" });
    copyDayOnto(SOURCE, target);

    expect(target.notes).toBe("Old note");
    expect(SOURCE.date).toBe("2026-07-01");
  });
});
