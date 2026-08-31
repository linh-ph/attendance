"use client";

import { useId, type ReactNode } from "react";
import type { WizardSummaryItem } from "./types";

/**
 * What the wizard is about to do, as a labelled list.
 *
 * The same list serves both surfaces the spec asks for: the shell renders it as
 * the desktop live summary beside the step, and a wizard's own review step
 * renders it in the main column, which is what a phone gets instead. One
 * renderer, so the review and the summary can never say different things.
 */

export interface WizardSummaryProps {
  title: string;
  items: readonly WizardSummaryItem[];
  /** A closing caution — typically what has *not* happened in Drive yet. */
  note?: ReactNode;
  /** `aside` beside the step, `section` inside a review step. */
  as?: "aside" | "section";
  /**
   * Defaults from `as`, and the default is the one to keep: `.wizard-summary`
   * is hidden below the desktop breakpoint — a phone gets the same list from
   * the review step as `.wizard-review`, which is always shown.
   */
  className?: string;
}

export function WizardSummary({
  title,
  items,
  note,
  as = "aside",
  className = as === "aside" ? "wizard-summary" : "wizard-review",
}: WizardSummaryProps) {
  const Tag = as;
  const headingId = useId();

  return (
    <Tag className={className} aria-labelledby={headingId}>
      <h2 id={headingId} className="wizard-summary-title">
        {title}
      </h2>

      <dl className="wizard-summary-list">
        {items.map((item) => (
          <div className="wizard-summary-item" key={item.label}>
            <dt className="wizard-summary-label">{item.label}</dt>
            <dd className="wizard-summary-value">{item.value}</dd>
          </div>
        ))}
      </dl>

      {note === undefined ? null : <p className="wizard-summary-note">{note}</p>}
    </Tag>
  );
}
