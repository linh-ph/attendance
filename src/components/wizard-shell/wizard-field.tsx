import type { ReactNode } from "react";

/**
 * Validation slots that sit beside the thing that is wrong.
 *
 * `WizardField` is the field-level slot and `WizardItem` the item-level one —
 * a member row, a mapped workbook sheet. Neither knows any wizard's rules: the
 * feature wizard decides what is invalid and hands the message down. What the
 * slots guarantee is the binding, because the red border and the announcement
 * are driven by the same two attributes and must never drift apart:
 * `aria-invalid` paints, `aria-describedby` speaks.
 *
 * The control itself stays the wizard's, through a render prop — `MonthInput`,
 * a Picker trigger and a plain `input` all bind identically.
 */

/** What a control must spread onto itself to be bound to its own error. */
export interface WizardControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export function describedBy(ids: readonly (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return present.length === 0 ? undefined : present.join(" ");
}

export interface WizardFieldProps {
  /** Control id; the hint and the error derive theirs from it. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** `undefined` means valid. A message means the control is marked invalid. */
  error?: string;
  /** Spans the full width of a field grid. */
  wide?: boolean;
  children: (control: WizardControlProps) => ReactNode;
}

export function WizardField({ id, label, hint, error, wide = false, children }: WizardFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const description = describedBy([hint !== undefined && hintId, error !== undefined && errorId]);

  const control: WizardControlProps = {
    id,
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
    ...(description === undefined ? {} : { "aria-describedby": description }),
  };

  return (
    <div className={wide ? "field field-wide" : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>

      {children(control)}

      {hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}

      {error === undefined ? null : (
        <p id={errorId} role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export interface WizardItemListProps {
  /** Names the list, so a screen reader can say what these rows are. */
  label: string;
  className?: string;
  children: ReactNode;
}

export function WizardItemList({
  label,
  className = "wizard-item-list",
  children,
}: WizardItemListProps) {
  return (
    <ul className={className} aria-label={label}>
      {children}
    </ul>
  );
}

export interface WizardItemProps {
  /** Row id; its error derives from it. */
  id: string;
  /** What this row is about — a sheet title, a member's name. */
  title: ReactNode;
  /** Secondary line, e.g. `31 attendance rows · August 2026`. */
  detail?: ReactNode;
  /** `undefined` means this row is fine. */
  error?: string;
  children?: ReactNode;
}

export function WizardItem({ id, title, detail, error, children }: WizardItemProps) {
  const errorId = `${id}-error`;

  return (
    <li
      className="wizard-item"
      data-state={error === undefined ? "ok" : "invalid"}
      {...(error === undefined ? {} : { "aria-describedby": errorId })}
    >
      <p className="wizard-item-title">{title}</p>
      {detail === undefined ? null : <p className="wizard-item-detail">{detail}</p>}

      {children}

      {error === undefined ? null : (
        <p id={errorId} role="alert" className="field-error">
          {error}
        </p>
      )}
    </li>
  );
}
