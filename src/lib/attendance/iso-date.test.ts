import { describe, expect, it } from "vitest";
import { fromIsoDate, isoMonthStart, toIsoDate } from "./iso-date";

describe("fromIsoDate", () => {
  it("keeps the calendar day the string names", () => {
    const date = fromIsoDate("2026-07-03");

    expect(date).not.toBe(null);
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(6);
    expect(date?.getDate()).toBe(3);
  });

  it("does not drift across a day, whatever the machine's offset is", () => {
    // `new Date("2026-08-29")` is parsed as UTC midnight, which is the previous
    // calendar day for anyone west of Greenwich. Every date here is local.
    for (const iso of ["2026-01-01", "2026-08-29", "2026-12-31"]) {
      expect(toIsoDate(fromIsoDate(iso) as Date)).toBe(iso);
    }
  });

  it("survives a round trip through the whole of a month", () => {
    for (let day = 1; day <= 31; day += 1) {
      const iso = `2026-07-${String(day).padStart(2, "0")}`;
      expect(toIsoDate(fromIsoDate(iso) as Date)).toBe(iso);
    }
  });

  it("rejects anything that is not a plain calendar date", () => {
    for (const value of ["", "2026-7-3", "not a date", "2026-13-01", "2026-07-32"]) {
      expect(fromIsoDate(value)).toBe(null);
    }
  });
});

describe("toIsoDate", () => {
  it("pads the month and day", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("reads local fields, not UTC ones", () => {
    // 23:30 local on the 3rd is the 4th in UTC for eastern offsets; the day
    // shown to the person is the one that matters.
    expect(toIsoDate(new Date(2026, 6, 3, 23, 30))).toBe("2026-07-03");
  });
});

describe("isoMonthStart", () => {
  it("returns the first of the month the date belongs to", () => {
    expect(toIsoDate(isoMonthStart("2026-07-29") as Date)).toBe("2026-07-01");
  });

  it("accepts a bare month", () => {
    expect(toIsoDate(isoMonthStart("2026-07") as Date)).toBe("2026-07-01");
  });

  it("returns null for anything unparseable", () => {
    expect(isoMonthStart("nonsense")).toBe(null);
  });
});
