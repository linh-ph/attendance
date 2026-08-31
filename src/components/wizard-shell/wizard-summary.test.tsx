import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WizardSummary } from "./wizard-summary";

const ITEMS = [
  { label: "File", value: "202609勤怠管理表" },
  { label: "Month", value: "September 2026" },
  { label: "Members", value: "2 people" },
] as const;

describe("WizardSummary", () => {
  it("is the desktop aside beside the step", () => {
    const { container } = render(<WizardSummary title="File summary" items={ITEMS} />);

    const aside = screen.getByRole("complementary", { name: "File summary" });
    expect(aside).toHaveClass("wizard-summary");
    expect(container.querySelectorAll(".wizard-summary-item")).toHaveLength(3);
  });

  it("becomes the review surface without inheriting the aside's desktop-only rule", () => {
    /*
     * `.wizard-summary` is hidden below the desktop breakpoint, because the
     * live summary is not squeezed in beside a phone's step. The review step
     * renders the same list, so it must not carry that class — otherwise the
     * mobile review, which is the whole point of the review step, disappears.
     */
    render(<WizardSummary as="section" title="Review" items={ITEMS} note="Nothing sent yet." />);

    const review = screen.getByRole("region", { name: "Review" });
    expect(review).toHaveClass("wizard-review");
    expect(review).not.toHaveClass("wizard-summary");
    expect(review).toHaveTextContent("Nothing sent yet.");
  });
});
