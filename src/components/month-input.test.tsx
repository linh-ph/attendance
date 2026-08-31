import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MonthInput } from "./month-input";

/**
 * jsdom implements no pickers, so `showPicker` is absent entirely. Each test
 * installs what it needs to observe and removes it again, so nothing leaks into
 * the suites that render these wizards.
 */
function withShowPicker(implementation: () => void): () => void {
  const input = HTMLInputElement.prototype as unknown as Record<string, unknown>;
  input.showPicker = implementation;

  return () => {
    delete input.showPicker;
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe("MonthInput", () => {
  it("opens the calendar when the field itself is clicked, not only its icon", () => {
    const showPicker = vi.fn();
    restore = withShowPicker(showPicker);

    render(<MonthInput id="month" value="2026-07" invalid={false} onChange={vi.fn()} />);
    fireEvent.click(document.getElementById("month") as HTMLInputElement);

    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it("still accepts typing when the browser refuses to open a picker", () => {
    restore = withShowPicker(() => {
      throw new Error("NotAllowedError");
    });
    const onChange = vi.fn<(next: string) => void>();

    render(<MonthInput id="month" value="2026-07" invalid={false} onChange={onChange} />);
    const input = document.getElementById("month") as HTMLInputElement;

    // The click must not take the field down with it.
    expect(() => fireEvent.click(input)).not.toThrow();

    fireEvent.change(input, { target: { value: "2026-08" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-08");
  });

  it("works on a browser that has no showPicker at all", () => {
    const onChange = vi.fn<(next: string) => void>();

    render(<MonthInput id="month" value="2026-07" invalid={false} onChange={onChange} />);
    const input = document.getElementById("month") as HTMLInputElement;

    expect(() => fireEvent.click(input)).not.toThrow();
    fireEvent.change(input, { target: { value: "2026-09" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-09");
  });

  it("carries the month, the type, and the invalid state", () => {
    render(<MonthInput id="month" value="2026-07" invalid onChange={vi.fn()} />);
    const input = document.getElementById("month") as HTMLInputElement;

    expect(input.type).toBe("month");
    expect(input.value).toBe("2026-07");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not open a picker on a disabled field", () => {
    const showPicker = vi.fn();
    restore = withShowPicker(showPicker);

    render(<MonthInput id="month" value="2026-07" invalid={false} onChange={vi.fn()} disabled />);
    fireEvent.click(document.getElementById("month") as HTMLInputElement);

    expect(showPicker).not.toHaveBeenCalled();
  });
});
