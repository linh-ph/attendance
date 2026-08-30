"use client";

import { useState, type FormEvent } from "react";
import type { AttendanceDay, TimeSlot } from "@/lib/attendance/model";
import { applyWorkBlock, TIME_SLOTS, type WorkBlock } from "@/lib/attendance/slots";

/**
 * The second editing method: one description written across a half-open block
 * `[start, end)`.
 *
 * The form produces a command, never a mutation. Expansion, lunch skipping, and
 * the overwrite set all come from `applyWorkBlock`, so the preview the user
 * confirms is computed by exactly the code that will run — the two editing
 * methods cannot disagree about which slots a block covers.
 */

const DESCRIPTION_REQUIRED = "Enter a work description.";
const END_NOT_AFTER_START = "The end time must be later than the start time.";
const NO_WRITABLE_SLOT = "Choose a range with at least one editable slot.";

/** `24:00` closes a block that runs to the end of the day. */
const END_BOUNDARIES: readonly string[] = [...TIME_SLOTS.slice(1), "24:00"];
const BOUNDARIES: readonly string[] = [...TIME_SLOTS, "24:00"];

/**
 * The standard working day. `17:00` is the half-open end of the block, so it
 * covers through the 16:30 slot and stops there, and the lunch hour is skipped
 * by `applyWorkBlock` rather than by these bounds.
 */
const DEFAULT_START = "08:00";
const DEFAULT_END = "17:00";

interface PendingReplacement {
  block: WorkBlock;
  overwritten: readonly TimeSlot[];
}

export interface WorkBlockFormProps {
  /** The live draft; the overwrite preview is computed against it. */
  day: AttendanceDay;
  onApply: (block: WorkBlock) => void;
  disabled?: boolean;
}

function boundaryIndex(value: string): number {
  return BOUNDARIES.indexOf(value);
}

function replacementNotice(overwritten: readonly TimeSlot[]): string {
  const noun = overwritten.length === 1 ? "slot" : "slots";
  return `Replacing existing work text in ${overwritten.length} ${noun}: ${overwritten.join(", ")}.`;
}

export function WorkBlockForm({ day, onApply, disabled = false }: WorkBlockFormProps) {
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReplacement | null>(null);

  function reset(): void {
    setError(null);
    setPending(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const trimmed = description.trim();
    if (trimmed === "") {
      setPending(null);
      setError(DESCRIPTION_REQUIRED);
      return;
    }

    if (boundaryIndex(end) <= boundaryIndex(start)) {
      setPending(null);
      setError(END_NOT_AFTER_START);
      return;
    }

    const block: WorkBlock = { start, end, description: trimmed };

    let overwritten: readonly TimeSlot[];
    try {
      overwritten = applyWorkBlock(day, block).overwrittenSlots;
    } catch {
      // The only remaining refusal is a range whose every slot is reserved.
      setPending(null);
      setError(NO_WRITABLE_SLOT);
      return;
    }

    setError(null);

    // Section 4.2: an overlapping block must show what it replaces first.
    if (overwritten.length > 0) {
      setPending({ block, overwritten });
      return;
    }

    setPending(null);
    onApply(block);
  }

  function confirmReplacement(): void {
    if (pending === null) return;

    const { block } = pending;
    setPending(null);
    onApply(block);
  }

  return (
    <div className="work-block">
      <form className="work-block-form" noValidate onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="work-block-start">Start</label>
          <select
            id="work-block-start"
            className="field-control"
            value={start}
            disabled={disabled}
            onChange={(event) => {
              setStart(event.target.value);
              reset();
            }}
          >
            {TIME_SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {slot}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="work-block-end">End</label>
          <select
            id="work-block-end"
            className="field-control"
            value={end}
            disabled={disabled}
            onChange={(event) => {
              setEnd(event.target.value);
              reset();
            }}
          >
            {END_BOUNDARIES.map((boundary) => (
              <option key={boundary} value={boundary}>
                {boundary}
              </option>
            ))}
          </select>
        </div>

        <div className="field field-wide">
          <label htmlFor="work-block-description">Work description</label>
          <input
            id="work-block-description"
            className="field-control"
            type="text"
            autoComplete="off"
            value={description}
            disabled={disabled}
            onChange={(event) => {
              setDescription(event.target.value);
              reset();
            }}
          />
        </div>

        <button type="submit" className="action action-primary" disabled={disabled}>
          Apply work block
        </button>
      </form>

      {error === null ? null : (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {pending === null ? null : (
        <div className="work-block-confirm">
          <p role="alert" className="work-block-warning">
            {replacementNotice(pending.overwritten)}
          </p>
          <div className="work-block-confirm-actions">
            <button
              type="button"
              className="action action-primary"
              disabled={disabled}
              onClick={confirmReplacement}
            >
              Replace
            </button>
            <button type="button" className="action" disabled={disabled} onClick={() => setPending(null)}>
              Keep existing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
