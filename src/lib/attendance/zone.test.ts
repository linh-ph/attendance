import { afterEach, describe, expect, it, vi } from "vitest";
import { isIanaTimeZone, normalizeSpreadsheetTimeZone, todayInZone } from "./zone";

/*
 * Vitest pins `TZ=America/Los_Angeles` (see `vitest.config.ts`), so every
 * assertion below that expects a non-Pacific answer is also proof that the
 * device timezone is not consulted.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("isIanaTimeZone", () => {
  it("accepts real IANA identifiers, including UTC", () => {
    expect(isIanaTimeZone("Asia/Tokyo")).toBe(true);
    expect(isIanaTimeZone("America/New_York")).toBe(true);
    expect(isIanaTimeZone("UTC")).toBe(true);
  });

  it("rejects a missing, empty, non-string, or unrecognized zone", () => {
    expect(isIanaTimeZone(undefined)).toBe(false);
    expect(isIanaTimeZone(null)).toBe(false);
    expect(isIanaTimeZone("")).toBe(false);
    expect(isIanaTimeZone("   ")).toBe(false);
    expect(isIanaTimeZone(9)).toBe(false);
    expect(isIanaTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("rejects the custom offset form Sheets falls back to for unrecognized zones", () => {
    // Sheets documents `GMT-07:00` as its custom-zone escape hatch. It is not
    // an IANA identifier, so it is reported as undeterminable rather than
    // silently reinterpreted.
    expect(isIanaTimeZone("GMT-07:00")).toBe(false);
  });
});

describe("normalizeSpreadsheetTimeZone", () => {
  it("returns the trimmed identifier when it is a real IANA zone", () => {
    expect(normalizeSpreadsheetTimeZone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
  });

  it("returns null — never a fallback zone — when it is missing or invalid", () => {
    expect(normalizeSpreadsheetTimeZone(undefined)).toBeNull();
    expect(normalizeSpreadsheetTimeZone(null)).toBeNull();
    expect(normalizeSpreadsheetTimeZone("")).toBeNull();
    expect(normalizeSpreadsheetTimeZone("Nowhere/Nothing")).toBeNull();
  });
});

describe("todayInZone", () => {
  it("is the spreadsheet's day, not UTC's, on the far side of UTC midnight", () => {
    // 2026-07-01T23:30Z is still 1 July in London and already 2 July in Tokyo.
    const instant = new Date("2026-07-01T23:30:00.000Z");

    expect(todayInZone("Asia/Tokyo", instant)).toBe("2026-07-02");
    expect(todayInZone("UTC", instant)).toBe("2026-07-01");
    expect(todayInZone("America/New_York", instant)).toBe("2026-07-01");
  });

  it("is the spreadsheet's day, not UTC's, on the near side of UTC midnight", () => {
    // 2026-07-02T02:30Z is already 2 July in UTC but still 1 July in New York.
    const instant = new Date("2026-07-02T02:30:00.000Z");

    expect(todayInZone("America/New_York", instant)).toBe("2026-07-01");
    expect(todayInZone("America/Los_Angeles", instant)).toBe("2026-07-01");
    expect(todayInZone("UTC", instant)).toBe("2026-07-02");
    expect(todayInZone("Asia/Tokyo", instant)).toBe("2026-07-02");
  });

  it("crosses a month boundary in the spreadsheet's zone", () => {
    const instant = new Date("2026-07-31T20:00:00.000Z");

    expect(todayInZone("Asia/Tokyo", instant)).toBe("2026-08-01");
    expect(todayInZone("America/Los_Angeles", instant)).toBe("2026-07-31");
  });

  it("returns a different day after a file-context change to another zone", () => {
    const instant = new Date("2026-07-01T15:00:00.000Z");
    const firstFileZone = "Pacific/Kiritimati"; // UTC+14
    const secondFileZone = "Pacific/Honolulu"; // UTC-10

    expect(todayInZone(firstFileZone, instant)).toBe("2026-07-02");
    expect(todayInZone(secondFileZone, instant)).toBe("2026-07-01");
  });

  it("returns null for a missing or invalid zone instead of guessing", () => {
    const instant = new Date("2026-07-01T23:30:00.000Z");

    expect(todayInZone(null, instant)).toBeNull();
    expect(todayInZone(undefined, instant)).toBeNull();
    expect(todayInZone("", instant)).toBeNull();
    expect(todayInZone("Not/AZone", instant)).toBeNull();
    expect(todayInZone("GMT-07:00", instant)).toBeNull();
  });

  it("pads single-digit months and days to the ISO shape", () => {
    expect(todayInZone("UTC", new Date("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05");
  });

  it("defaults to the current instant when none is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T23:30:00.000Z"));

    expect(todayInZone("Asia/Tokyo")).toBe("2026-07-02");
  });
});
