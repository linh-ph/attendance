import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WizardShell } from "./wizard-shell";
import type { WizardStep } from "./types";

const STEPS: readonly WizardStep[] = [
  { id: "details", label: "File details", description: "Name, month, folder" },
  { id: "members", label: "Members", description: "People and tabs" },
  { id: "review", label: "Review", description: "Sharing and notifications" },
];

function renderShell(overrides: Partial<React.ComponentProps<typeof WizardShell>> = {}) {
  return render(
    <WizardShell
      title="Create monthly file"
      purpose="One file per month, shared with the people who record hours in it."
      steps={STEPS}
      currentStepId="details"
      stepTitle="File details"
      stepLede="Name the file, choose its month, and pick where it goes."
      actions={
        <>
          <button type="button" className="btn-secondary">
            Back
          </button>
          <button type="button">Continue to members</button>
        </>
      }
      {...overrides}
    >
      <input aria-label="File name" defaultValue="" />
    </WizardShell>,
  );
}

describe("WizardShell", () => {
  it("states its title and its purpose, and gives the step one principal task", () => {
    renderShell();

    expect(screen.getByRole("heading", { level: 1, name: "Create monthly file" })).toBeVisible();
    expect(
      screen.getByText("One file per month, shared with the people who record hours in it."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "File details" })).toBeVisible();
    expect(screen.getByLabelText("File name")).toBeVisible();
  });

  it("puts the step body and its actions in one keyboard-complete order", () => {
    const { container } = renderShell();

    const actions = container.querySelector(".wizard-actions");
    expect(actions).not.toBeNull();
    // The action row is the shared sticky primitive, not a private copy of it.
    expect(actions).toHaveClass("sticky-actions");

    const back = screen.getByRole("button", { name: "Back" });
    const next = screen.getByRole("button", { name: "Continue to members" });

    back.focus();
    expect(document.activeElement).toBe(back);
    next.focus();
    expect(document.activeElement).toBe(next);

    // The step's own control precedes the actions in the document, so Tab
    // reaches the fields before the commit.
    expect(
      screen.getByLabelText("File name").compareDocumentPosition(next) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("announces a status politely without moving focus", () => {
    const { rerender, container } = renderShell();

    const field = screen.getByLabelText("File name");
    field.focus();

    rerender(
      <WizardShell
        title="Create monthly file"
        steps={STEPS}
        currentStepId="details"
        stepTitle="File details"
        status="Creating file…"
        busy
        actions={<button type="button">Create file</button>}
      >
        <input aria-label="File name" defaultValue="" />
      </WizardShell>,
    );

    const live = container.querySelector(".wizard-status");
    expect(live).toHaveTextContent("Creating file…");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live?.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(field);
  });

  it("focuses the first invalid control only after a submitted step fails", () => {
    const props = {
      title: "Create monthly file",
      steps: STEPS,
      currentStepId: "details",
      stepTitle: "File details",
      actions: <button type="button">Continue</button>,
    } as const;

    const { rerender } = render(
      <WizardShell {...props} submitAttempt={0}>
        <input aria-label="File name" aria-invalid={undefined} />
        <input aria-label="Month" aria-invalid={undefined} />
      </WizardShell>,
    );

    // Typing turns a field invalid without a submit: focus must not jump.
    rerender(
      <WizardShell {...props} submitAttempt={0}>
        <input aria-label="File name" aria-invalid />
        <input aria-label="Month" aria-invalid />
      </WizardShell>,
    );
    expect(document.activeElement).toBe(document.body);

    // The submitted step fails: the first invalid control takes focus.
    rerender(
      <WizardShell {...props} submitAttempt={1}>
        <input aria-label="File name" aria-invalid />
        <input aria-label="Month" aria-invalid />
      </WizardShell>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("File name"));

    // A submitted step that passes leaves focus alone.
    screen.getByLabelText("Month").focus();
    rerender(
      <WizardShell {...props} submitAttempt={2}>
        <input aria-label="File name" />
        <input aria-label="Month" />
      </WizardShell>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Month"));
  });

  it("submits the step from the keyboard when the wizard hands it a submit handler", () => {
    const onSubmit = vi.fn();

    const { container } = render(
      <WizardShell
        title="Import workbook"
        steps={STEPS}
        currentStepId="details"
        stepTitle="Output file"
        onSubmit={onSubmit}
        actions={<button type="submit">Save to Google Drive</button>}
      >
        <input aria-label="Output file name" />
      </WizardShell>,
    );

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("novalidate");

    fireEvent.submit(form as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps a live summary beside the step and a banner above the fields", () => {
    renderShell({
      banner: <p className="field-error">Google refused the folder.</p>,
      summaryTitle: "File summary",
      summary: [
        { label: "File", value: "202609勤怠管理表" },
        { label: "Month", value: "September 2026" },
      ],
      summaryNote: "Google Drive permissions are applied only after review.",
    });

    const summary = screen.getByRole("complementary", { name: "File summary" });
    expect(summary).toHaveTextContent("202609勤怠管理表");
    expect(summary).toHaveTextContent("September 2026");
    expect(summary).toHaveTextContent("Google Drive permissions are applied only after review.");
    expect(screen.getByText("Google refused the folder.")).toBeVisible();
  });
});
