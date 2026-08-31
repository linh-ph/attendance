import type { ReactNode } from "react";

/**
 * The vocabulary the wizard shell and the three feature wizards share.
 *
 * The shell owns steps and chrome; a feature wizard owns its data, its
 * validation, and every call to Google. Nothing in this file describes a
 * particular wizard's fields, which is why it can be imported by all three.
 */

/** One step of a wizard sequence, in the order it is presented. */
export interface WizardStep {
  /** Stable identifier — also the value passed back by `onStepSelect`. */
  id: string;
  /** Short rail label, e.g. `File details`. */
  label: string;
  /** One line saying what the step is for, e.g. `Name, month, folder`. */
  description?: string;
}

/** Where a step sits relative to the one being shown. */
export type WizardStepState = "done" | "current" | "upcoming";

/**
 * Spoken equivalent of the rail's mark. Colour never carries state on its own,
 * so every rail item also says where it is in words.
 */
export const WIZARD_STEP_STATE_LABELS: Record<WizardStepState, string> = {
  done: "Completed",
  current: "Current step",
  upcoming: "Not started",
};

/** One line of the live summary, and of the review that mirrors it. */
export interface WizardSummaryItem {
  label: string;
  value: ReactNode;
}
