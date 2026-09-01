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

  it("draws the whole month even when there is no attendance data at all", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("grid", { name: "August 2026 attendance calendar" })).toBeVisible();

    // August 2026 has 31 days and starts on a Saturday, so the grid runs from
    // Sunday 26 July to Saturday 5 September: 42 cells.
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    expect(
      screen.getByRole("gridcell", { name: /Saturday, August 1, 2026.*No timesheet data/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("gridcell", { name: /Monday, August 31, 2026.*No timesheet data/i }),
    ).toBeVisible();
  });

  it("completes the first and last weeks with real neighbouring dates", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("gridcell", { name: /Sunday, July 26, 2026 — Outside August 2026/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("gridcell", { name: /Saturday, September 5, 2026 — Outside August 2026/i }),
    ).toBeVisible();
  });

  it("leaves a date with no sheet row inert, because there is nothing to open", () => {
    const onSelect = vi.fn();
    render(
      <MonthCalendar
        month="2026-08"
        days={[recordedDay("2026-08-03")]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={onSelect}
      />,
    );

    const withoutData = screen.getByRole("gridcell", {
      name: /Tuesday, August 4, 2026.*No timesheet data/i,
    });
    fireEvent.click(withoutData);
    expect(onSelect).not.toHaveBeenCalled();

    // The date that does have a row is still a working control.
    fireEvent.click(screen.getByRole("gridcell", { name: /Monday, August 3, 2026.*Recorded/i }));
    expect(onSelect).toHaveBeenCalledWith("2026-08-03", expect.any(HTMLButtonElement));
  });

  it("still marks weekends when it has no data to read them from", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[]}
        selectedDate={null}
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    // 2026-08-02 is a Sunday; the date alone settles that.
    expect(
      screen.getByRole("gridcell", { name: /Sunday, August 2, 2026.*Non-working day/i }),
    ).toBeVisible();
  });

  /**
   * The template fills clock in, clock out and a break on every working day, so
   * a day that reads `Not recorded` is one nobody has filled in. When it has
   * also already passed, it is the thing a person opens this calendar to find.
   */
  it("marks a passed working day with nothing recorded as Missing", () => {
    render(
      <MonthCalendar
        month="2026-08"
        // 31 August 2026 is a Monday: template values, empty work report.
        days={[{ ...emptyDay("2026-08-31"), statusCode: "office", clockIn: 8, clockOut: 17, breakHours: 1 }]}
        selectedDate={null}
        todayDate="2026-09-01"
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const cell = screen.getByRole("gridcell", { name: /Monday, August 31, 2026/ });
    expect(cell).toHaveAccessibleName(/Not recorded/);
    expect(cell).toHaveAccessibleName(/Missing/);
    expect(cell.className).toContain("is-missing");
  });

  it("does not mark a weekend as Missing — nothing is owed on it", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[emptyDay("2026-08-30")]}
        selectedDate={null}
        todayDate="2026-09-01"
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    const cell = screen.getByRole("gridcell", { name: /Sunday, August 30, 2026/ });
    expect(cell).toHaveAccessibleName(/Not recorded/);
    expect(cell).not.toHaveAccessibleName(/Missing/);
    expect(cell.className).not.toContain("is-missing");
  });

  it("does not mark a day that has not happened yet", () => {
    render(
      <MonthCalendar
        month="2026-09"
        // A Wednesday, after the spreadsheet's today.
        days={[emptyDay("2026-09-30")]}
        selectedDate={null}
        todayDate="2026-09-01"
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("gridcell", { name: /Wednesday, September 30, 2026/ }).className,
    ).not.toContain("is-missing");
  });

  it("marks every gap when the spreadsheet reports no timezone", () => {
    render(
      <MonthCalendar
        month="2026-08"
        days={[emptyDay("2026-08-31")]}
        selectedDate={null}
        // No usable zone: there is no today to compare against, so a month that
        // has clearly passed still shows its gaps.
        todayDate={null}
        localDates={new Set()}
        attentionDates={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("gridcell", { name: /Monday, August 31, 2026/ }).className,
    ).toContain("is-missing");
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
    expect(legend).toHaveTextContent("Missing");
    expect(legend).toHaveTextContent("Not recorded");
    expect(legend).toHaveTextContent("No timesheet data");
    expect(legend).toHaveTextContent("Non-working day");
    expect(legend).toHaveTextContent("Local changes");
    expect(legend).toHaveTextContent("Needs attention");
  });
});
