import type { AttendanceDay, TimeSlot } from "./model";
import { calculateWorkHours } from "./validation";

export const TIME_SLOTS = Array.from({ length: 36 }, (_, index) => {
  const value = 6 + index / 2;
  const hour = Math.floor(value);
  return `${String(hour).padStart(2, "0")}:${value % 1 === 0.5 ? "30" : "00"}` as TimeSlot;
});

const LUNCH_SLOTS: readonly TimeSlot[] = ["12:00", "12:30"];

export interface WorkBlock {
  start: string;
  end: string;
  description: string;
}

export type WorkBlockResult = AttendanceDay & { overwrittenSlots: TimeSlot[] };

export function isSlotWritable(day: AttendanceDay, slot: TimeSlot): boolean {
  return !(day.lunchBreak && LUNCH_SLOTS.includes(slot));
}

export function applyWorkBlock(day: AttendanceDay, block: WorkBlock): WorkBlockResult {
  const startIndex = TIME_SLOTS.indexOf(block.start as TimeSlot);
  const endIndex = block.end === "24:00" ? TIME_SLOTS.length : TIME_SLOTS.indexOf(block.end as TimeSlot);
  if (startIndex < 0 || endIndex < 0) throw new Error("invalid-boundary");
  if (endIndex <= startIndex || block.description.trim() === "") throw new Error("empty-work-block");

  const writableSlots = TIME_SLOTS.slice(startIndex, endIndex).filter((slot) => isSlotWritable(day, slot));
  if (writableSlots.length === 0) throw new Error("empty-work-block");

  const overwrittenSlots = writableSlots.filter((slot) => day.slots[slot] !== "");
  const slots = { ...day.slots };
  for (const slot of writableSlots) slots[slot] = block.description;

  return { ...day, slots, overwrittenSlots };
}

export function setLunchBreak(day: AttendanceDay, enabled: boolean): AttendanceDay {
  const slots = { ...day.slots };
  if (enabled) {
    for (const slot of LUNCH_SLOTS) slots[slot] = "";
  }

  const breakHours = enabled ? 1 : day.breakHours;
  return {
    ...day,
    slots,
    lunchBreak: enabled,
    breakHours,
    workHours: calculateWorkHours({ ...day, breakHours }),
  };
}
