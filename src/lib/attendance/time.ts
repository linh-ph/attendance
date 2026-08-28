import type { TimeSlot } from "./model";

export function timeToDecimal(value: string): number | null {
  const match = /^(\d{2}):(00|30)$/.exec(value);
  if (!match) return null;

  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;

  return hour + (match[2] === "30" ? 0.5 : 0);
}

export function decimalToTime(value: number): TimeSlot | null {
  if (!Number.isFinite(value) || value < 0 || value > 23.5 || value * 2 !== Math.round(value * 2)) {
    return null;
  }

  const hour = Math.floor(value);
  const minute = value % 1 === 0.5 ? "30" : "00";
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

export function isHalfHourDecimal(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 23.5 && value * 2 === Math.round(value * 2);
}

export function hasHalfHourIncrement(value: number): boolean {
  return Number.isFinite(value) && value * 2 === Math.round(value * 2);
}
