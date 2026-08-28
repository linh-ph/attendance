import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import type { WorkBlock } from "@/lib/attendance/slots";
import { WorkBlockForm } from "./work-block-form";

function day(overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay("2026-07-01"), ...overrides };
}

function withSlots(values: Record<string, string>, overrides: Partial<AttendanceDay> = {}) {
  const base = emptyDay("2026-07-01");
  return day({ slots: { ...base.slots, ...values }, ...overrides });
}

function renderForm(
  attendanceDay: AttendanceDay = day(),
  props: { disabled?: boolean } = {},
): { applied: WorkBlock[] } {
  const applied: WorkBlock[] = [];

  render(
    <WorkBlockForm day={attendanceDay} onApply={(block) => applied.push(block)} {...props} />,
  );

  return { applied };
}

function fillBlock(start: string, end: string, description: string): void {
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: start } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: end } });
  fireEvent.change(screen.getByLabelText("Work description"), { target: { value: description } });
}

describe("WorkBlockForm", () => {
  it("offers 30-minute boundaries and a 24:00 end boundary", () => {
    renderForm();

    const startOptions = Array.from(
      screen.getByLabelText("Start").querySelectorAll("option"),
    ).map((option) => option.getAttribute("value"));
    const endOptions = Array.from(
      screen.getByLabelText("End").querySelectorAll("option"),
    ).map((option) => option.getAttribute("value"));

    expect(startOptions[0]).toBe("06:00");
    expect(startOptions.at(-1)).toBe("23:30");
    expect(endOptions[0]).toBe("06:30");
    expect(endOptions.at(-1)).toBe("24:00");
  });

  it("applies a half-open block straight away when no slot is overwritten", () => {
    const { applied } = renderForm();

    fillBlock("09:00", "10:00", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([{ start: "09:00", end: "10:00", description: "Client report" }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the slots that would be replaced before applying an overlapping block", () => {
    const { applied } = renderForm(withSlots({ "09:00": "Standup", "09:30": "Standup" }));

    fillBlock("09:00", "10:30", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("09:00, 09:30");

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(applied).toEqual([{ start: "09:00", end: "10:30", description: "Client report" }]);
  });

  it("keeps the existing work text when the replacement is declined", () => {
    const { applied } = renderForm(withSlots({ "09:00": "Standup" }));

    fillBlock("09:00", "10:00", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep existing" }));

    expect(applied).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses an empty work description", () => {
    const { applied } = renderForm();

    fillBlock("09:00", "10:00", "   ");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a work description.");
  });

  it("refuses an end boundary that is not after the start", () => {
    const { applied } = renderForm();

    fillBlock("10:00", "09:00", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The end time must be later than the start time.",
    );
  });

  it("refuses a block whose slots are all reserved for the lunch break", () => {
    const { applied } = renderForm(day({ lunchBreak: true }));

    fillBlock("12:00", "13:00", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a range with at least one editable slot.",
    );
  });

  it("ignores reserved lunch slots when previewing an overlapping block", () => {
    const { applied } = renderForm(
      withSlots({ "12:00": "Lunch admin", "13:00": "Standup" }, { lunchBreak: true }),
    );

    fillBlock("11:30", "13:30", "Client report");
    fireEvent.click(screen.getByRole("button", { name: "Apply work block" }));

    expect(applied).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("13:00");
    expect(screen.getByRole("alert")).not.toHaveTextContent("12:00");
  });

  it("disables the block controls while a save is in flight", () => {
    renderForm(day(), { disabled: true });

    expect(screen.getByLabelText("Start")).toBeDisabled();
    expect(screen.getByLabelText("End")).toBeDisabled();
    expect(screen.getByLabelText("Work description")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply work block" })).toBeDisabled();
  });
});
