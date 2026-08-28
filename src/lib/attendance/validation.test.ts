import { describe, expect, it } from "vitest";
import { emptyDay, STATUS_OPTIONS } from "./model";
import { calculateWorkHours, validateAttendanceDay } from "./validation";

describe("attendance validation", () => {
  it("calculates work hours from clock and break values", () => {
    expect(calculateWorkHours({ clockIn: 8, clockOut: 17.5, breakHours: 1 })).toBe(8.5);
    expect(calculateWorkHours({ clockIn: null, clockOut: 17.5, breakHours: 1 })).toBeNull();
  });

  it("reports negative work hours and excessive breaks", () => {
    const day = { ...emptyDay("2026-07-01"), clockIn: 8, clockOut: 8.5, breakHours: 1 };

    expect(validateAttendanceDay(day, STATUS_OPTIONS).map((issue) => issue.code)).toEqual([
      "break-too-long",
      "work-hours-negative",
    ]);
  });

  it("reports invalid clock ordering, negative breaks, and unknown statuses", () => {
    const day = { ...emptyDay("2026-07-01"), statusCode: "remote", clockIn: 17, clockOut: 8, breakHours: -0.5 };

    expect(validateAttendanceDay(day, STATUS_OPTIONS).map((issue) => issue.code)).toEqual([
      "clock-order",
      "break-negative",
      "work-hours-negative",
      "unknown-status",
    ]);
  });

  it("rejects non-half-hour breaks, midnight clock values, and negative stored work hours", () => {
    const day = {
      ...emptyDay("2026-07-01"),
      clockIn: 8,
      clockOut: 24,
      breakHours: 0.25,
      workHours: -1,
    };

    expect(validateAttendanceDay(day, STATUS_OPTIONS).map((issue) => issue.code)).toEqual([
      "invalid-boundary",
      "work-hours-negative",
    ]);
  });

  it("reports both invalid-boundary and break-negative for a negative fractional break", () => {
    const day = { ...emptyDay("2026-07-01"), breakHours: -0.25 };

    expect(validateAttendanceDay(day, STATUS_OPTIONS).map((issue) => issue.code)).toEqual([
      "invalid-boundary",
      "break-negative",
    ]);
  });
});
