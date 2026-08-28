import { describe, expect, it } from "vitest";
import { decimalToTime, timeToDecimal } from "./time";

describe("attendance time primitives", () => {
  it("converts half-hour decimal values to 24-hour times", () => {
    expect(decimalToTime(8)).toBe("08:00");
    expect(decimalToTime(17.5)).toBe("17:30");
  });

  it("converts valid half-hour times to decimal values", () => {
    expect(timeToDecimal("23:30")).toBe(23.5);
  });

  it("rejects values outside half-hour boundaries", () => {
    expect(decimalToTime(8.25)).toBeNull();
    expect(timeToDecimal("09:15")).toBeNull();
  });
});
