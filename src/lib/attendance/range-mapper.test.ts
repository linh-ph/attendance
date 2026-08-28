import { describe, expect, it } from "vitest";
import { emptyDay, STATUS_OPTIONS } from "./model";
import { diffDay } from "./range-mapper";

describe("attendance dirty range mapper", () => {
  it("emits only the changed writable slot cell", () => {
    const baseline = emptyDay("2026-07-01");
    const current = { ...baseline, slots: { ...baseline.slots, "09:00": "Client report" } };

    expect(diffDay(baseline, current, 7, STATUS_OPTIONS)).toEqual([
      { range: "P7", baseline: "", value: "Client report" },
    ]);
  });

  it("maps the final 23:30 slot to AS", () => {
    const baseline = emptyDay("2026-07-01");
    const current = { ...baseline, slots: { ...baseline.slots, "23:30": "Close" } };

    expect(diffDay(baseline, current, 7, STATUS_OPTIONS)).toEqual([
      { range: "AS7", baseline: "", value: "Close" },
    ]);
  });

  it("maps writable summary fields but never formula-owned work hours", () => {
    const baseline = emptyDay("2026-07-01");
    const current = {
      ...baseline,
      statusCode: "office",
      clockIn: 8,
      clockOut: 17.5,
      breakHours: 1,
      workHours: 8.5,
      notes: "Client visit",
    };

    expect(diffDay(baseline, current, 7, STATUS_OPTIONS)).toEqual([
      { range: "D7", baseline: null, value: "出社" },
      { range: "E7", baseline: null, value: 8 },
      { range: "F7", baseline: null, value: 17.5 },
      { range: "G7", baseline: 0, value: 1 },
      { range: "I7", baseline: "", value: "Client visit" },
    ]);
  });

  it("uses the configured sheet value for a future status", () => {
    const baseline = emptyDay("2026-07-01");
    const current = { ...baseline, statusCode: "remote" };
    const statuses = [...STATUS_OPTIONS, { code: "remote", labelEn: "Remote", sheetValue: "在宅" }];

    expect(diffDay(baseline, current, 7, statuses)).toEqual([
      { range: "D7", baseline: null, value: "在宅" },
    ]);
  });

  it("fails explicitly when a changed status lacks a configured sheet value", () => {
    const baseline = emptyDay("2026-07-01");
    const current = { ...baseline, statusCode: "remote" };

    expect(() => diffDay(baseline, current, 7, STATUS_OPTIONS)).toThrow("unknown-status");
  });
});
