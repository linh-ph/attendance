import { describe, expect, it } from "vitest";
import {
  DAYS_IN_WEEK,
  buildMonthGrid,
  monthOfDate,
  shiftMonth,
  weekdayOrder,
} from "./calendar-grid";

const flat = (month: string, weekStartsOn?: number) =>
  buildMonthGrid(month, weekStartsOn === undefined ? {} : { weekStartsOn }).flatMap(
    (week) => week.cells,
  );

const inMonthDates = (month: string) =>
  flat(month)
    .filter((cell) => cell.inMonth)
    .map((cell) => cell.date);

describe("buildMonthGrid", () => {
  it("builds a grid for a month with no data at all — the calendar is not data-dependent", () => {
    const weeks = buildMonthGrid("2026-07");

    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks.every((week) => week.cells.length === DAYS_IN_WEEK)).toBe(true);
  });

  it("covers every date of the month, once, in order", () => {
    const dates = inMonthDates("2026-07");

    expect(dates).toHaveLength(31);
    expect(dates[0]).toBe("2026-07-01");
    expect(dates.at(-1)).toBe("2026-07-31");
    expect(new Set(dates).size).toBe(31);
  });

  it("pads the first and last rows with real neighbouring dates, not blanks", () => {
    // 2026-07-01 is a Wednesday, so Sunday..Tuesday come from June.
    const cells = flat("2026-07");

    expect(cells.slice(0, 3).map((cell) => cell.date)).toEqual([
      "2026-06-28",
      "2026-06-29",
      "2026-06-30",
    ]);
    expect(cells.slice(0, 3).every((cell) => cell.inMonth)).toBe(false);
    expect(cells.at(-1)?.date).toBe("2026-08-01");
    expect(cells.at(-1)?.inMonth).toBe(false);
  });

  it("puts every date under its own weekday column", () => {
    for (const week of buildMonthGrid("2026-07")) {
      expect(week.cells.map((cell) => cell.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it("handles a leap February and a month starting on the first column", () => {
    expect(inMonthDates("2028-02")).toHaveLength(29);
    expect(inMonthDates("2026-02")).toHaveLength(28);

    // 2026-03-01 is a Sunday: no leading padding at all.
    const march = flat("2026-03");
    expect(march[0].date).toBe("2026-03-01");
    expect(march[0].inMonth).toBe(true);
  });

  it("crosses a year boundary in both directions", () => {
    const january = flat("2026-01");
    const december = flat("2026-12");

    expect(january[0].date.startsWith("2025-12")).toBe(true);
    expect(december.at(-1)?.date.startsWith("2027-01")).toBe(true);
  });

  it("starts the week where it is told to", () => {
    const mondayFirst = buildMonthGrid("2026-07", { weekStartsOn: 1 });

    expect(mondayFirst[0].cells[0].weekday).toBe(1);
    expect(mondayFirst[0].cells[0].date).toBe("2026-06-29");
    // Still every date of July, only rearranged.
    expect(mondayFirst.flatMap((week) => week.cells).filter((cell) => cell.inMonth)).toHaveLength(
      31,
    );
  });

  it("gives each row a key that is stable and distinct", () => {
    const keys = buildMonthGrid("2026-07").map((week) => week.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(buildMonthGrid("2026-07").map((week) => week.key)).toEqual(keys);
  });

  it("returns nothing only when the value is not a month", () => {
    expect(buildMonthGrid("")).toEqual([]);
    expect(buildMonthGrid("2026-13")).toEqual([]);
    expect(buildMonthGrid("2026-7")).toEqual([]);
    expect(buildMonthGrid("2026-07-01")).toEqual([]);
  });
});

describe("weekdayOrder", () => {
  it("lists the header columns in the order the grid uses", () => {
    expect(weekdayOrder()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("shiftMonth", () => {
  it("moves by whole months across year boundaries", () => {
    expect(shiftMonth("2026-07", 1)).toBe("2026-08");
    expect(shiftMonth("2026-07", -1)).toBe("2026-06");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-01", -13)).toBe("2024-12");
  });

  it("refuses anything that is not a month", () => {
    expect(shiftMonth("2026-13", 1)).toBeNull();
    expect(shiftMonth("", 1)).toBeNull();
  });
});

describe("monthOfDate", () => {
  it("reads the month a date belongs to", () => {
    expect(monthOfDate("2026-07-31")).toBe("2026-07");
    expect(monthOfDate("2026-07-32")).toBeNull();
  });
});
