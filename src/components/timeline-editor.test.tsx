import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyDay, type AttendanceDay, type TimeSlot } from "@/lib/attendance/model";
import { TIME_SLOTS } from "@/lib/attendance/slots";
import { TimelineEditor } from "./timeline-editor";

function day(overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay("2026-07-01"), ...overrides };
}

function renderTimeline(
  overrides: Partial<AttendanceDay> = {},
  props: { disabled?: boolean } = {},
): { edits: Array<{ slot: TimeSlot; value: string }> } {
  const edits: Array<{ slot: TimeSlot; value: string }> = [];

  render(
    <TimelineEditor
      day={day(overrides)}
      onSlotChange={(slot, value) => edits.push({ slot, value })}
      {...props}
    />,
  );

  return { edits };
}

describe("TimelineEditor", () => {
  it("renders one labelled input for each of the 36 work-report slots", () => {
    renderTimeline();

    expect(screen.getAllByRole("textbox")).toHaveLength(TIME_SLOTS.length);
    expect(screen.getByLabelText("06:00 work")).toBeInTheDocument();
    expect(screen.getByLabelText("23:30 work")).toBeInTheDocument();
  });

  it("shows the work text already in the day", () => {
    renderTimeline({ slots: { ...emptyDay("2026-07-01").slots, "09:00": "Client report" } });

    expect(screen.getByLabelText("09:00 work")).toHaveValue("Client report");
    expect(screen.getByLabelText("09:30 work")).toHaveValue("");
  });

  it("reports a single-slot edit to the caller", () => {
    const { edits } = renderTimeline();

    fireEvent.change(screen.getByLabelText("14:30 work"), { target: { value: "Review" } });

    expect(edits).toEqual([{ slot: "14:30", value: "Review" }]);
  });

  it("reserves the two lunch slots while lunch break is selected", () => {
    renderTimeline({ lunchBreak: true });

    expect(screen.getByLabelText("12:00 work")).toBeDisabled();
    expect(screen.getByLabelText("12:30 work")).toBeDisabled();
    expect(screen.getByLabelText("11:30 work")).toBeEnabled();
    expect(screen.getByLabelText("13:00 work")).toBeEnabled();
    expect(screen.getAllByText("Reserved for lunch break")).toHaveLength(2);
  });

  it("leaves both lunch slots editable when lunch break is not selected", () => {
    renderTimeline({ lunchBreak: false });

    expect(screen.getByLabelText("12:00 work")).toBeEnabled();
    expect(screen.getByLabelText("12:30 work")).toBeEnabled();
    expect(screen.queryByText("Reserved for lunch break")).toBeNull();
  });

  it("disables the whole timeline while a save is in flight", () => {
    renderTimeline({}, { disabled: true });

    for (const input of screen.getAllByRole("textbox")) {
      expect(input).toBeDisabled();
    }
  });

  it("exposes the timeline as a keyboard-reachable named region", () => {
    renderTimeline();

    const region = screen.getByRole("group", { name: "Work report timeline" });
    expect(region).toHaveAttribute("tabindex", "0");
  });
});
