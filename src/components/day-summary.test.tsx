import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import type { ConfigStatus } from "@/lib/config/schema";
import { DaySummary, type DaySummaryChange } from "./day-summary";

const STATUSES: ConfigStatus[] = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
];

function day(overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay("2026-07-01"), ...overrides };
}

function renderSummary(
  overrides: Partial<AttendanceDay> = {},
  props: { disabled?: boolean } = {},
): { changes: DaySummaryChange[] } {
  const changes: DaySummaryChange[] = [];

  render(
    <DaySummary
      day={day(overrides)}
      statuses={STATUSES}
      onChange={(change) => changes.push(change)}
      {...props}
    />,
  );

  return { changes };
}

describe("DaySummary", () => {
  it("offers the configured status enum as a select and never a free-text field", () => {
    renderSummary();

    const status = screen.getByLabelText("Status");
    expect(status.tagName).toBe("SELECT");
    expect(
      Array.from(status.querySelectorAll("option")).map((option) => option.textContent),
    ).toEqual(["Not set", "Office", "Absent"]);
    expect(screen.queryByText("出社")).toBeNull();
  });

  it("emits the status code rather than the sheet text", () => {
    const { changes } = renderSummary();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "absent" } });
    expect(changes).toEqual([{ field: "status", value: "absent" }]);

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "" } });
    expect(changes.at(-1)).toEqual({ field: "status", value: null });
  });

  it("renders decimal clock values on a 24-hour clock", () => {
    renderSummary({ clockIn: 8, clockOut: 17.5 });

    expect(screen.getByLabelText("Clock in")).toHaveValue("08:00");
    expect(screen.getByLabelText("Clock out")).toHaveValue("17:30");
  });

  it("emits decimal hours when a 24-hour time is chosen", () => {
    const { changes } = renderSummary();

    fireEvent.change(screen.getByLabelText("Clock in"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Clock out"), { target: { value: "18:00" } });

    expect(changes).toEqual([
      { field: "clockIn", value: 9.5 },
      { field: "clockOut", value: 18 },
    ]);
  });

  it("derives work hours from the same rule as the sheet formula", () => {
    renderSummary({ clockIn: 8, clockOut: 17.5, breakHours: 1 });

    expect(screen.getByLabelText("Work hours")).toHaveTextContent("8.5 hours");
  });

  it("shows no work hours until both clock values exist", () => {
    renderSummary({ clockIn: 8, clockOut: null, breakHours: 1 });

    expect(screen.getByLabelText("Work hours")).toHaveTextContent("—");
  });

  it("labels the lunch break exactly and emits the toggle", () => {
    const { changes } = renderSummary();

    const lunch = screen.getByLabelText("Lunch break · 12:00–13:00");
    expect(lunch).not.toBeChecked();

    fireEvent.click(lunch);
    expect(changes).toEqual([{ field: "lunchBreak", value: true }]);
  });

  it("locks break hours to one hour while lunch break is selected", () => {
    renderSummary({ lunchBreak: true, breakHours: 1 });

    const breakHours = screen.getByLabelText("Break hours");
    expect(breakHours).toHaveValue(1);
    expect(breakHours).toBeDisabled();
    expect(screen.getByLabelText("Lunch break · 12:00–13:00")).toBeChecked();
  });

  it("lets break hours be entered manually when lunch break is not selected", () => {
    const { changes } = renderSummary({ breakHours: 0 });

    const breakHours = screen.getByLabelText("Break hours");
    expect(breakHours).toBeEnabled();

    fireEvent.change(breakHours, { target: { value: "0.5" } });
    expect(changes).toEqual([{ field: "breakHours", value: 0.5 }]);
  });

  it("emits daily notes", () => {
    const { changes } = renderSummary();

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Left early" } });
    expect(changes).toEqual([{ field: "notes", value: "Left early" }]);
  });

  it("disables every editable field while a save is in flight", () => {
    renderSummary({}, { disabled: true });

    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Clock in")).toBeDisabled();
    expect(screen.getByLabelText("Clock out")).toBeDisabled();
    expect(screen.getByLabelText("Break hours")).toBeDisabled();
    expect(screen.getByLabelText("Notes")).toBeDisabled();
    expect(screen.getByLabelText("Lunch break · 12:00–13:00")).toBeDisabled();
  });

  it("does not call back when nothing changed", () => {
    const onChange = vi.fn();
    render(<DaySummary day={day()} statuses={STATUSES} onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
  });
});
