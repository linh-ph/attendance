import { describe, expect, it } from "vitest";
import type { AttendanceDay } from "@/lib/attendance/model";
import {
  INITIAL_REVISION,
  canonicalJson,
  hashDay,
  hashValue,
  nextRevision,
  sameBaseline,
} from "./revisions";

const day = (over: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({
    date: "2026-07-03",
    statusCode: "office",
    clockIn: 8,
    clockOut: 17.5,
    breakHours: 1,
    workHours: 8.5,
    lunchBreak: true,
    notes: "",
    slots: { "09:00": "work", "09:30": "" },
    ...over,
  }) as AttendanceDay;

describe("canonical serialization", () => {
  it("orders keys so property order can never change a hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes an absent property from an explicit null", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}));
  });
});

describe("baseline hashing", () => {
  it("gives the same hash to two rows read identically", () => {
    expect(hashDay(day())).toBe(hashDay(day()));
  });

  it("changes when any field of the row changes", () => {
    const base = hashDay(day());

    expect(hashDay(day({ clockIn: 9 }))).not.toBe(base);
    expect(hashDay(day({ notes: "late" }))).not.toBe(base);
    expect(hashDay(day({ slots: { "09:00": "meeting", "09:30": "" } } as Partial<AttendanceDay>))).not.toBe(base);
  });
});

describe("byte-for-byte baseline comparison", () => {
  it("accepts an identical row and refuses one that moved on", () => {
    expect(sameBaseline(day(), day())).toBe(true);
    expect(sameBaseline(day(), day({ breakHours: 0 }))).toBe(false);
  });

  it("does not treat a re-ordered slot map as a different row", () => {
    const reordered = day({ slots: { "09:30": "", "09:00": "work" } } as Partial<AttendanceDay>);
    expect(sameBaseline(day(), reordered)).toBe(true);
  });
});

describe("local revisions", () => {
  it("starts at the initial revision and increases by one", () => {
    expect(INITIAL_REVISION).toBe(0);
    expect(nextRevision(null)).toBe(1);
    expect(nextRevision(INITIAL_REVISION)).toBe(1);
    expect(nextRevision(7)).toBe(8);
  });

  it("never goes backwards when a stored value is nonsense", () => {
    expect(nextRevision(Number.NaN)).toBe(1);
    expect(nextRevision(-4)).toBe(1);
  });
});
