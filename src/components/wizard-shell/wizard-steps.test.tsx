import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { WizardSteps } from "./wizard-steps";

const STEPS = [
  { id: "details", label: "File details", description: "Name, month, folder" },
  { id: "members", label: "Members", description: "People and tabs" },
  { id: "review", label: "Review", description: "Sharing and notifications" },
  { id: "setup", label: "Setup", description: "Create and configure" },
] as const;

describe("WizardSteps", () => {
  it("names the position and the current step in one readable line", () => {
    render(<WizardSteps title="Create monthly file" steps={STEPS} currentStepId="members" />);

    expect(screen.getByText("Step 2 of 4 · Members")).toBeInTheDocument();
  });

  it("marks completed, current and upcoming steps in words, not colour alone", () => {
    render(<WizardSteps title="Create monthly file" steps={STEPS} currentStepId="members" />);

    const rail = screen.getByRole("list", { name: "Create monthly file steps" });
    const items = within(rail).getAllByRole("listitem");

    expect(items).toHaveLength(4);
    expect(items[0]).toHaveAttribute("data-state", "done");
    expect(items[1]).toHaveAttribute("data-state", "current");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[2]).toHaveAttribute("data-state", "upcoming");
    expect(items[0]).toHaveTextContent("Completed");
    expect(items[2]).toHaveTextContent("Not started");
  });

  it("lets the keyboard walk back to a completed step when the wizard allows it", () => {
    const onStepSelect = vi.fn<(id: string) => void>();

    render(
      <WizardSteps
        title="Create monthly file"
        steps={STEPS}
        currentStepId="members"
        onStepSelect={onStepSelect}
      />,
    );

    const back = screen.getByRole("button", { name: /File details/ });
    back.focus();
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    expect(onStepSelect).toHaveBeenCalledExactlyOnceWith("details");

    // A step that has not been reached yet is never a target.
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
  });

  it("keeps the compact progress bar decorative, because the kicker already says it", () => {
    const { container } = render(
      <WizardSteps title="Import workbook" steps={STEPS} currentStepId="details" />,
    );

    const bar = container.querySelector(".wizard-progress");
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar?.querySelectorAll(".wizard-progress-seg")).toHaveLength(4);
  });
});
