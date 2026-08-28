import { describe, expect, it } from "vitest";
import { emptyDay } from "./model";
import {
  applyWorkBlock,
  isSlotWritable,
  setLunchBreak,
  TIME_SLOTS,
} from "./slots";

describe("attendance work slots", () => {
  it("defines exactly the writable half-hour slots", () => {
    expect(TIME_SLOTS).toHaveLength(36);
    expect(TIME_SLOTS.at(0)).toBe("06:00");
    expect(TIME_SLOTS.at(-1)).toBe("23:30");
  });

  it("applies a work block as a half-open interval without mutating the day", () => {
    const day = emptyDay("2026-07-01");
    const changed = applyWorkBlock(day, {
      start: "09:00",
      end: "10:00",
      description: "Client report",
    });

    expect(changed.slots["09:00"]).toBe("Client report");
    expect(changed.slots["09:30"]).toBe("Client report");
    expect(changed.slots["10:00"]).toBe("");
    expect(day.slots["09:00"]).toBe("");
  });

  it("reports overwritten non-empty slots for confirmation", () => {
    const day = applyWorkBlock(emptyDay("2026-07-01"), {
      start: "09:00",
      end: "09:30",
      description: "Existing work",
    });

    const changed = applyWorkBlock(day, {
      start: "09:00",
      end: "10:00",
      description: "Replacement work",
    });

    expect(changed.overwrittenSlots).toEqual(["09:00"]);
  });

  it("reserves lunch slots and recalculates the break without mutating input", () => {
    const changed = applyWorkBlock(emptyDay("2026-07-01"), {
      start: "09:00",
      end: "13:00",
      description: "Client report",
    });
    const lunch = setLunchBreak(changed, true);

    expect(lunch.breakHours).toBe(1);
    expect(lunch.slots["12:00"]).toBe("");
    expect(lunch.slots["12:30"]).toBe("");
    expect(isSlotWritable(lunch, "12:00")).toBe(false);
    expect(changed.slots["12:00"]).toBe("Client report");
  });

  it("rejects invalid work block boundaries and empty descriptions", () => {
    const day = emptyDay("2026-07-01");

    expect(() => applyWorkBlock(day, { start: "09:15", end: "10:00", description: "Work" })).toThrow("invalid-boundary");
    expect(() => applyWorkBlock(day, { start: "10:00", end: "10:00", description: "Work" })).toThrow("empty-work-block");
    expect(() => applyWorkBlock(day, { start: "09:00", end: "10:00", description: "" })).toThrow("empty-work-block");
  });

  it("rejects a block that covers only reserved lunch slots", () => {
    const day = setLunchBreak(emptyDay("2026-07-01"), true);

    expect(() => applyWorkBlock(day, { start: "12:00", end: "13:00", description: "Work" })).toThrow("empty-work-block");
  });
});
