export type TimeSlot = `${string}:${"00" | "30"}`;
export type WorkBlockBoundary = TimeSlot | "24:00";
export type StatusCode = string;

export interface AttendanceDay {
  date: string;
  statusCode: StatusCode | null;
  clockIn: number | null;
  clockOut: number | null;
  breakHours: number;
  workHours: number | null;
  lunchBreak: boolean;
  notes: string;
  slots: Record<TimeSlot, string>;
}

export const STATUS_OPTIONS = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
] as const;

export function emptyDay(date: string): AttendanceDay {
  const slots = {} as Record<TimeSlot, string>;

  for (let hour = 6; hour < 24; hour += 1) {
    slots[`${String(hour).padStart(2, "0")}:00`] = "";
    slots[`${String(hour).padStart(2, "0")}:30`] = "";
  }

  return {
    date,
    statusCode: null,
    clockIn: null,
    clockOut: null,
    breakHours: 0,
    workHours: null,
    lunchBreak: false,
    notes: "",
    slots,
  };
}
