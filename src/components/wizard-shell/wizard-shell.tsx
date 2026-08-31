"use client";

import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { focusFirstInvalidField } from "./focus-invalid";
import { WizardSteps } from "./wizard-steps";
import { WizardSummary } from "./wizard-summary";
import type { WizardStep, WizardSummaryItem } from "./types";

/**
 * The chrome the three wizards share (spec section 7.3).
 *
 * Create, Import and legacy Setup are the same shape — an explicit purpose, a
 * sequence with one principal task per step, validation next to what is wrong,
 * a review before Drive is touched, and a recovery surface once it has been —
 * so they get one shell rather than three near-copies.
 *
 * The boundary is deliberate and narrow: **the shell owns steps and chrome, a
 * feature wizard owns its data, its validation and every call to Google.**
 * Nothing here knows what a month, a member or a workbook is. The two places
 * that boundary is easiest to violate are `summary`, which takes rendered
 * values rather than a wizard's state, and `submitAttempt`, which is a counter
 * the wizard increments — the shell never decides that a step failed.
 *
 * Layout: a rail, the step, and the live summary in one panel on a desktop; a
 * single column with the compact progress indicator on a phone, where the
 * summary is not squeezed in beside the step but shown by the wizard's own
 * review step, using the same `WizardSummary`.
 */

export interface WizardShellProps {
  /** What this wizard is, e.g. `Create monthly file`. Rendered as the `h1`. */
  title: string;
  /** One sentence on why it exists and what it will do. */
  purpose?: ReactNode;

  steps: readonly WizardStep[];
  /** Which step is on screen. Earlier steps read as done, later as upcoming. */
  currentStepId: string;
  /** Supply to let the keyboard return to an already-completed step. */
  onStepSelect?: (stepId: string) => void;

  /** The one principal task of this step. Rendered as the `h2`. */
  stepTitle: string;
  /** One sentence of guidance under it. */
  stepLede?: ReactNode;
  /** The step's own fields — the feature wizard's markup. */
  children: ReactNode;

  /**
   * A notice that belongs to the whole step rather than to one field: the API
   * failure, the workbook caution. Field- and item-level messages belong in
   * `children`, beside what they are about.
   */
  banner?: ReactNode;

  /** Announced politely; never moves focus. */
  status?: string | null;
  /** Marks the status as work in progress once a mutation has begun. */
  busy?: boolean;

  /** Desktop live summary. Omit on a step that has nothing to summarize. */
  summary?: readonly WizardSummaryItem[];
  summaryTitle?: string;
  summaryNote?: ReactNode;

  /** The sticky row: Back and Continue, or Back and the commit action. */
  actions: ReactNode;

  /**
   * Increment once per **submitted** step attempt. When this changes and the
   * step still holds an `aria-invalid` control, that control takes focus. It
   * does not change while someone types, which is exactly why focus does not
   * move then.
   */
  submitAttempt?: number;

  /** When given, the step is a form, so Enter commits it from the keyboard. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

export function WizardShell({
  title,
  purpose,
  steps,
  currentStepId,
  onStepSelect,
  stepTitle,
  stepLede,
  children,
  banner,
  status = null,
  busy = false,
  summary,
  summaryTitle = "Summary",
  summaryNote,
  actions,
  submitAttempt = 0,
  onSubmit,
}: WizardShellProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const stepHeadingId = useId();

  /*
   * Moves focus and nothing else — no state is set here, so this stays on the
   * right side of `react-hooks/set-state-in-effect`. It runs only when the
   * attempt counter changes, which is the wizard saying "this step was
   * submitted", and it does nothing at all when the step turned out valid.
   */
  useEffect(() => {
    if (submitAttempt === 0) return;
    focusFirstInvalidField(bodyRef.current);
  }, [submitAttempt]);

  const body = (
    <>
      <div className="wizard-step-body" ref={bodyRef}>
        <div className="wizard-step-head">
          <h2 id={stepHeadingId} className="wizard-step-title">
            {stepTitle}
          </h2>
          {stepLede === undefined ? null : <p className="wizard-lede">{stepLede}</p>}
        </div>

        {banner === undefined ? null : <div className="wizard-banner">{banner}</div>}

        {children}
      </div>

      <p
        role="status"
        aria-live="polite"
        className={busy ? "wizard-status wizard-status-busy" : "wizard-status"}
      >
        {status === null ? "" : status}
      </p>

      <div className="wizard-actions sticky-actions">{actions}</div>
    </>
  );

  return (
    <section className="wizard" aria-labelledby={headingId}>
      <header className="wizard-head">
        <h1 id={headingId}>{title}</h1>
        {purpose === undefined ? null : <p className="page-lede">{purpose}</p>}
      </header>

      <div className="wizard-layout">
        <WizardSteps
          title={title}
          steps={steps}
          currentStepId={currentStepId}
          onStepSelect={onStepSelect}
        />

        {onSubmit === undefined ? (
          <div className="wizard-main">{body}</div>
        ) : (
          <form className="wizard-main" noValidate onSubmit={onSubmit}>
            {body}
          </form>
        )}

        {summary === undefined ? null : (
          <WizardSummary title={summaryTitle} items={summary} note={summaryNote} />
        )}
      </div>
    </section>
  );
}
