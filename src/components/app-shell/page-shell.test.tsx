import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageShell } from "./page-shell";

/**
 * The slot contract every screen renders into. These assertions are the
 * contract itself: a screen may fill the slots, but it may not move the
 * landmark, the heading level, or the sticky footer somewhere else.
 */

describe("the page shell", () => {
  it("renders one main landmark named by its own heading", () => {
    render(
      <PageShell title="Timesheets">
        <p>Body</p>
      </PageShell>,
    );

    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading", { level: 1, name: "Timesheets" });

    expect(main).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading.id).not.toBe("");
    expect(main).toContainElement(screen.getByText("Body"));
  });

  it("fills the header slots when they are supplied", () => {
    render(
      <PageShell
        eyebrow="blended-asia"
        title="Managed files"
        lede="Create and share the month."
        status={<span>Synced</span>}
        actions={<button type="button">New file</button>}
      >
        <p>Body</p>
      </PageShell>,
    );

    expect(screen.getByText("blended-asia")).toBeVisible();
    expect(screen.getByText("Create and share the month.")).toBeVisible();
    expect(screen.getByText("Synced")).toBeVisible();
    expect(screen.getByRole("button", { name: "New file" })).toBeVisible();
  });

  it("omits every optional slot that is not supplied", () => {
    const { container } = render(
      <PageShell title="Timesheets">
        <p>Body</p>
      </PageShell>,
    );

    expect(container.querySelector(".eyebrow")).toBeNull();
    expect(container.querySelector(".page-lede")).toBeNull();
    expect(container.querySelector(".page-status")).toBeNull();
    expect(container.querySelector(".page-header-actions")).toBeNull();
    expect(container.querySelector(".page-footer")).toBeNull();
  });

  it("renders an optional sticky footer with the shared safe-area treatment", () => {
    const { container } = render(
      <PageShell title="Day" footer={<button type="submit">Save</button>}>
        <p>Body</p>
      </PageShell>,
    );

    const footer = container.querySelector(".page-footer");

    expect(footer).not.toBeNull();
    expect(footer).toHaveClass("sticky-actions");
    expect(footer).toContainElement(screen.getByRole("button", { name: "Save" }));
  });

  it("lets a screen add its own rhythm class to the content region without replacing it", () => {
    const { container } = render(
      <PageShell title="Dashboard" contentClassName="dashboard">
        <p>Body</p>
      </PageShell>,
    );

    const content = container.querySelector(".page-content");

    expect(content).toHaveClass("dashboard");
  });

  it("accepts a caller-supplied heading id so a screen can point at it", () => {
    render(
      <PageShell title="Members" titleId="roster-title">
        <p>Body</p>
      </PageShell>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Members" })).toHaveAttribute(
      "id",
      "roster-title",
    );
    expect(screen.getByRole("main")).toHaveAttribute("aria-labelledby", "roster-title");
  });
});
