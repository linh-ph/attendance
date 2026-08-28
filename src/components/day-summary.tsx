import type { AttendanceDay } from "@/lib/attendance/model";
import { TIME_SLOTS } from "@/lib/attendance/slots";
import { decimalToTime, timeToDecimal } from "@/lib/attendance/time";
import { calculateWorkHours } from "@/lib/attendance/validation";
import type { ConfigStatus } from "@/lib/config/schema";

/**
 * Domain fields of one attendance day: status (D), clock in (E), clock out (F),
 * break (G), and notes (I), plus the derived work hours of column H.
 *
 * The component is presentational: it renders the draft it is given and reports
 * intent. It never mutates a day, never computes work hours itself, and never
 * offers free-form status text — the enum comes from the protected
 * configuration and the select emits the status *code*, never the sheet value.
 *
 * Column H is derived here with the same `calculateWorkHours` rule the sheet
 * formula uses, so the number on screen cannot drift from `=F-G-E`.
 */

/** The exact label required by design section 3.3. */
export const LUNCH_BREAK_LABEL = "Lunch break · 12:00–13:00";

export type DaySummaryChange =
  | { field: "status"; value: string | null }
  | { field: "clockIn"; value: number | null }
  | { field: "clockOut"; value: number | null }
  | { field: "breakHours"; value: number }
  | { field: "lunchBreak"; value: boolean }
  | { field: "notes"; value: string };

export interface DaySummaryProps {
  day: AttendanceDay;
  /** Configured status enum; the only status values the web may write. */
  statuses: readonly ConfigStatus[];
  onChange: (change: DaySummaryChange) => void;
  /** Set while a save is in flight so the draft cannot move under the request. */
  disabled?: boolean;
}

const NO_VALUE = "—";

/** Decimal hours to a 24-hour select value; the wire format stays decimal. */
function toTimeValue(decimal: number | null): string {
  return decimal === null ? "" : (decimalToTime(decimal) ?? "");
}

function formatWorkHours(workHours: number | null): string {
  if (workHours === null) return NO_VALUE;
  return `${workHours} ${Math.abs(workHours) === 1 ? "hour" : "hours"}`;
}

function parseBreakHours(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface TimeFieldProps {
  id: string;
  label: string;
  value: number | null;
  disabled: boolean;
  onSelect: (decimal: number | null) => void;
}

function TimeField({ id, label, value, disabled, onSelect }: TimeFieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="field-control"
        value={toTimeValue(value)}
        disabled={disabled}
        onChange={(event) => onSelect(timeToDecimal(event.target.value))}
      >
        <option value="">{NO_VALUE}</option>
        {TIME_SLOTS.map((slot) => (
          <option key={slot} value={slot}>
            {slot}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DaySummary({ day, statuses, onChange, disabled = false }: DaySummaryProps) {
  const workHours = calculateWorkHours(day);

  return (
    <div className="day-summary">
      <div className="field">
        <label htmlFor="day-status">Status</label>
        <select
          id="day-status"
          className="field-control"
          value={day.statusCode ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({ field: "status", value: event.target.value === "" ? null : event.target.value })
          }
        >
          <option value="">Not set</option>
          {statuses.map((status) => (
            <option key={status.code} value={status.code}>
              {status.labelEn}
            </option>
          ))}
        </select>
      </div>

      <TimeField
        id="day-clock-in"
        label="Clock in"
        value={day.clockIn}
        disabled={disabled}
        onSelect={(value) => onChange({ field: "clockIn", value })}
      />

      <TimeField
        id="day-clock-out"
        label="Clock out"
        value={day.clockOut}
        disabled={disabled}
        onSelect={(value) => onChange({ field: "clockOut", value })}
      />

      <div className="field">
        <label htmlFor="day-break-hours">Break hours</label>
        <input
          id="day-break-hours"
          className="field-control"
          type="number"
          step={0.5}
          min={0}
          value={day.breakHours}
          // The reserved lunch hour owns the break while it is selected, so the
          // two controls can never disagree about column G.
          disabled={disabled || day.lunchBreak}
          onChange={(event) =>
            onChange({ field: "breakHours", value: parseBreakHours(event.target.value) })
          }
        />
      </div>

      <div className="field field-derived">
        <span className="field-label" id="day-work-hours-label">
          Work hours
        </span>
        <output className="work-hours" aria-labelledby="day-work-hours-label">
          {formatWorkHours(workHours)}
        </output>
      </div>

      <div className="field field-checkbox">
        <input
          id="day-lunch-break"
          type="checkbox"
          checked={day.lunchBreak}
          disabled={disabled}
          onChange={(event) => onChange({ field: "lunchBreak", value: event.target.checked })}
        />
        <label htmlFor="day-lunch-break">{LUNCH_BREAK_LABEL}</label>
      </div>

      <div className="field field-wide">
        <label htmlFor="day-notes">Notes</label>
        <textarea
          id="day-notes"
          className="field-control"
          rows={3}
          value={day.notes}
          disabled={disabled}
          onChange={(event) => onChange({ field: "notes", value: event.target.value })}
        />
      </div>
    </div>
  );
}
