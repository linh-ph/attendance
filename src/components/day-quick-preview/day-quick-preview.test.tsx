import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyDay } from "@/lib/attendance/model";
import { DayQuickPreview } from "./day-quick-preview";

describe("DayQuickPreview", () => {
  it("shows a read-only attendance summary and full-detail route", () => {
    const day = {
      ...emptyDay("2026-08-03"),
      statusCode: "office",
      clockIn: 9,
      clockOut: 18,
      breakHours: 1,
      workHours: 8,
      notes: "Prepared the release",
      slots: { ...emptyDay("2026-08-03").slots, "09:00": "Planning" },
    };

    render(
      <DayQuickPreview
        day={day}
        statusLabel="Office"
        syncState="saved-locally"
        lastCheckedLabel="Last checked 09:30"
        detailHref="/files/file-1/attendance/22?date=2026-08-03"
        returnFocusElement={null}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Monday, August 3, 2026" });
    expect(dialog).toHaveTextContent("Recorded");
    expect(dialog).toHaveTextContent("09:00");
    expect(dialog).toHaveTextContent("18:00");
    expect(dialog).toHaveTextContent("Prepared the release");
    expect(dialog).toHaveTextContent("Planning");
    expect(screen.getByRole("link", { name: "Open full detail" })).toHaveAttribute(
      "href",
      "/files/file-1/attendance/22?date=2026-08-03",
    );
    expect(dialog.querySelector("input, textarea, select")).toBeNull();
  });

  it("closes on Escape and restores focus to the date trigger", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button>August 3</button>
      </>,
    );
    const returnFocusElement = screen.getByRole("button", {
      name: "August 3",
    }) as HTMLButtonElement;
    rerender(
      <>
        <button>August 3</button>
        <DayQuickPreview
          day={emptyDay("2026-08-03")}
          statusLabel={null}
          syncState="synced"
          lastCheckedLabel={null}
          detailHref="/detail"
          returnFocusElement={returnFocusElement}
          onClose={onClose}
        />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(returnFocusElement).toHaveFocus();
  });
});
