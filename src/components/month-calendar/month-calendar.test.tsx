import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import { MonthCalendar } from "./month-calendar";

function recordedDay(date: string): AttendanceDay {
  return { ...emptyDay(date), statusCode: "office", workHours: 8 };
}

describe("MonthCalendar", () => {
  it("renders Recorded and Not recorded as named date states", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[recordedDay("2026-08-03"), emptyDay("2026-08-04")]}
        selectedDate="2026-08-03"
        todayDate="2026-08-04"
        localDates={new Set(["2026-08-03"])}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("grid", { name: "August 2026 attendance calendar" })).toBeVisible();
    expect(
      screen.getByRole("gridcell", {
        name: /Monday, August 3, 2026.*Recorded.*Local changes.*Selected/i,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("gridcell", {
        name: /Tuesday, August 4, 2026.*Not recorded.*Today/i,
      }),
    ).toBeVisible();
  });

  it("moves focus with arrow keys and activates a date with Enter", () => {
    const onSelect = vi.fn();
    render(
      <MonthCalendar
        month="2026-08"
        days={[recordedDay("2026-08-03"), emptyDay("2026-08-04")]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={onSelect}
      />,
    );

    const monday = screen.getByRole("gridcell", { name: /Monday, August 3, 2026/i });
    const tuesday = screen.getByRole("gridcell", { name: /Tuesday, August 4, 2026/i });
    monday.focus();
    fireEvent.keyDown(monday, { key: "ArrowRight" });
    expect(tuesday).toHaveFocus();
    fireEvent.keyDown(tuesday, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("2026-08-04", expect.any(HTMLButtonElement));
  });

  it("explains every visible state in a persistent legend", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[emptyDay("2026-08-01")]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const legend = screen.getByLabelText("Calendar legend");
    expect(legend).toHaveTextContent("Recorded");
    expect(legend).toHaveTextContent("Not recorded");
    expect(legend).toHaveTextContent("Non-working day");
    expect(legend).toHaveTextContent("Local changes");
    expect(legend).toHaveTextContent("Needs attention");
  });
});
