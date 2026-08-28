import type { AttendanceDay } from "./model";
import { isHalfHourDecimal } from "./time";

export type ValidationIssueCode =
  | "invalid-boundary"
  | "clock-order"
  | "break-negative"
  | "break-too-long"
  | "work-hours-negative"
  | "unknown-status"
  | "empty-work-block";

export interface ValidationIssue {
  code: ValidationIssueCode;
}

export interface WorkHourInput {
  clockIn: number | null;
  clockOut: number | null;
  breakHours: number;
}

export function calculateWorkHours({ clockIn, clockOut, breakHours }: WorkHourInput): number | null {
  if (clockIn === null || clockOut === null) return null;
  return clockOut - breakHours - clockIn;
}

export function validateAttendanceDay(
  day: AttendanceDay,
  configuredStatuses: ReadonlyArray<{ code: string }>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasInvalidClock = (day.clockIn !== null && !isHalfHourDecimal(day.clockIn))
    || (day.clockOut !== null && !isHalfHourDecimal(day.clockOut))
    || (day.breakHours >= 0 && !isHalfHourDecimal(day.breakHours));
  if (hasInvalidClock) issues.push({ code: "invalid-boundary" });

  if (day.clockIn !== null && day.clockOut !== null && day.clockOut <= day.clockIn) {
    issues.push({ code: "clock-order" });
  }
  if (day.breakHours < 0) issues.push({ code: "break-negative" });

  if (
    day.clockIn !== null
    && day.clockOut !== null
    && day.clockOut > day.clockIn
    && day.breakHours > day.clockOut - day.clockIn
  ) {
    issues.push({ code: "break-too-long" });
  }

  const workHours = calculateWorkHours(day);
  if ((workHours !== null && workHours < 0) || (day.workHours !== null && day.workHours < 0)) {
    issues.push({ code: "work-hours-negative" });
  }

  if (day.statusCode !== null && !configuredStatuses.some((status) => status.code === day.statusCode)) {
    issues.push({ code: "unknown-status" });
  }

  return issues;
}
