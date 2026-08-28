import type { AttendanceDay, TimeSlot } from "@/lib/attendance/model";
import { isSlotWritable, TIME_SLOTS } from "@/lib/attendance/slots";

/**
 * The 30-minute work report (columns J:AS) as one labelled input per slot.
 *
 * Every row is an ordinary text input, so the whole timeline is reachable and
 * editable with the keyboard alone. Whether a slot may receive work text is not
 * decided here: `isSlotWritable` is the single rule, so a slot reserved by the
 * lunch break is disabled by the same logic that makes a work block skip it.
 */

const RESERVED_NOTICE = "Reserved for lunch break";

export interface TimelineEditorProps {
  day: AttendanceDay;
  onSlotChange: (slot: TimeSlot, value: string) => void;
  /** Set while a save is in flight. */
  disabled?: boolean;
}

function slotInputId(slot: TimeSlot): string {
  return `slot-${slot.replace(":", "-")}`;
}

export function TimelineEditor({ day, onSlotChange, disabled = false }: TimelineEditorProps) {
  return (
    <div
      className="timeline"
      role="group"
      aria-label="Work report timeline"
      // A scroll region needs to be focusable to be scrollable by keyboard.
      tabIndex={0}
    >
      <ol className="timeline-list">
        {TIME_SLOTS.map((slot) => {
          const writable = isSlotWritable(day, slot);
          const inputId = slotInputId(slot);

          return (
            <li className={writable ? "timeline-row" : "timeline-row timeline-row-reserved"} key={slot}>
              <label className="timeline-label" htmlFor={inputId}>
                <span className="timeline-time">{slot}</span>
                <span className="timeline-label-suffix"> work</span>
              </label>
              <input
                id={inputId}
                className="timeline-input"
                type="text"
                autoComplete="off"
                value={day.slots[slot]}
                disabled={disabled || !writable}
                onChange={(event) => onSlotChange(slot, event.target.value)}
              />
              {writable ? null : <span className="timeline-reserved">{RESERVED_NOTICE}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
