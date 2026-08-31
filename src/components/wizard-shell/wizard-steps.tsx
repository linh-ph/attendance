"use client";

import { WIZARD_STEP_STATE_LABELS, type WizardStep, type WizardStepState } from "./types";

/**
 * Where you are in a wizard, said twice for two viewports.
 *
 * Desktop gets the rail — every step, its purpose, and its state. Narrow
 * viewports get the compact indicator: a `Step 2 of 4 · Members` kicker and a
 * segmented bar. The kicker is the accessible statement of position and is
 * always in the document, so the bar can be decorative and the rail can be
 * hidden on a phone without taking the information with it.
 *
 * Steps are gated by validation, so the rail is not a tab strip: only a step
 * already completed can be returned to, and only when the wizard passes
 * `onStepSelect`. Everything else is text.
 */

export interface WizardStepsProps {
  /** Wizard title; names the rail's list for assistive technology. */
  title: string;
  steps: readonly WizardStep[];
  currentStepId: string;
  /** Omit to make the rail read-only. */
  onStepSelect?: (stepId: string) => void;
}

function stateOf(index: number, currentIndex: number): WizardStepState {
  if (index < currentIndex) return "done";
  return index === currentIndex ? "current" : "upcoming";
}

/** `✓` for a finished step, otherwise its human position. */
function markOf(state: WizardStepState, index: number): string {
  return state === "done" ? "✓" : String(index + 1);
}

export function WizardSteps({ title, steps, currentStepId, onStepSelect }: WizardStepsProps) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === currentStepId),
  );
  const current = steps[currentIndex];

  return (
    <nav className="wizard-steps" aria-label={`${title} progress`}>
      <p className="wizard-steps-kicker">
        {`Step ${currentIndex + 1} of ${steps.length}${current ? ` · ${current.label}` : ""}`}
      </p>

      {/*
       * Decorative on purpose: the kicker above already names the position, and
       * announcing the same thing twice is noise rather than help.
       */}
      <span className="wizard-progress" aria-hidden="true">
        {steps.map((step, index) => (
          <span
            key={step.id}
            className="wizard-progress-seg"
            data-state={stateOf(index, currentIndex)}
          />
        ))}
      </span>

      <ol className="wizard-rail" aria-label={`${title} steps`}>
        {steps.map((step, index) => {
          const state = stateOf(index, currentIndex);
          const label = (
            <>
              <span className="wizard-rail-mark" aria-hidden="true">
                {markOf(state, index)}
              </span>
              <span className="wizard-rail-copy">
                <span className="wizard-rail-label">{step.label}</span>
                {step.description === undefined ? null : (
                  <span className="wizard-rail-hint">{step.description}</span>
                )}
                <span className="sr-only">{WIZARD_STEP_STATE_LABELS[state]}</span>
              </span>
            </>
          );

          return (
            <li
              key={step.id}
              className="wizard-rail-step"
              data-state={state}
              {...(state === "current" ? { "aria-current": "step" as const } : {})}
            >
              {state === "done" && onStepSelect !== undefined ? (
                <button
                  type="button"
                  className="btn-ghost wizard-rail-link"
                  onClick={() => onStepSelect(step.id)}
                >
                  {label}
                </button>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
