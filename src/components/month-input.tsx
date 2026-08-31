"use client";

import type { MouseEvent } from "react";

/**
 * A `YYYY-MM` field whose calendar opens from anywhere on the control.
 *
 * A bare `<input type="month">` only opens its picker from the small calendar
 * icon at the right-hand edge; clicking the field itself just places a caret in
 * the text segments. People reasonably read the whole control as the button and
 * click the middle of it, where nothing happens.
 *
 * `showPicker()` is the platform's own way to open it. It throws rather than
 * returning a value when the browser refuses — no user activation, or a browser
 * that does not implement it — and a picker that will not open is not worth
 * breaking the field over, so the typing still works either way.
 */

export interface MonthInputProps {
  id: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function MonthInput({ id, value, invalid, onChange, disabled = false }: MonthInputProps) {
  function openPicker(event: MouseEvent<HTMLInputElement>): void {
    try {
      event.currentTarget.showPicker();
    } catch {
      // Left to the icon, exactly as before.
    }
  }

  return (
    <input
      id={id}
      type="month"
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      onClick={openPicker}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
