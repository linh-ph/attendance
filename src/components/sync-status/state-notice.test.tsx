import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StateNotice, StateSkeleton } from "./state-notice";
import { describeSystemState } from "./state-catalog";

describe("StateNotice", () => {
  it("renders the catalog's three answers for the state it is given", () => {
    render(<StateNotice state="offline-local-safe" />);
    const state = describeSystemState("offline-local-safe");

    expect(screen.getByText(state.title)).toBeVisible();
    expect(screen.getByText(state.dataSafety)).toBeVisible();
    expect(screen.getByText(state.guidance)).toBeVisible();
  });

  it("names the group so a screen reader can reach it as a region", () => {
    render(<StateNotice state="folder-unavailable" />);
    const state = describeSystemState("folder-unavailable");

    expect(screen.getByRole("group", { name: state.title })).toBeVisible();
  });

  it("keeps a card-scoped failure out of the page's error channel", () => {
    const { container } = render(<StateNotice state="invalid-workbook" />);

    expect(container.querySelector(".state-notice-card")).not.toBeNull();
    expect(container.querySelector(".state-notice-page")).toBeNull();
  });

  it("lets a screen raise a state to page scope without re-wording it", () => {
    const { container } = render(<StateNotice state="invalid-workbook" scope="page" />);

    expect(container.querySelector(".state-notice-page")).not.toBeNull();
  });

  it("renders only the recovery actions the caller wired up", () => {
    const onRetry = vi.fn();
    render(<StateNotice state="provider-failure" onRetry={onRetry} />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers Re-authenticate as a link to the sign-in route", () => {
    render(<StateNotice state="authentication-expired" />);

    expect(screen.getByRole("link", { name: "Re-authenticate" })).toHaveAttribute("href", "/login");
  });

  it("offers Resume for a partial setup and calls back once", () => {
    const onResume = vi.fn();
    render(<StateNotice state="partial-setup" onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("offers Reload when the sheet moved under the baseline", () => {
    const onReload = vi.fn();
    render(<StateNotice state="remote-changes-detected" onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("disables recovery while a recovery attempt is already running", () => {
    render(<StateNotice state="provider-failure" onRetry={() => undefined} busy />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("renders one screen-specific action beside the shared recovery grammar", () => {
    render(
      <StateNotice
        state="no-timesheet"
        action={{ label: "Choose timesheet", href: "/timesheets" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Choose timesheet" })).toHaveAttribute(
      "href",
      "/timesheets",
    );
  });

  it("announces a notice politely and does not move focus", () => {
    render(<StateNotice state="local-changes-pending" />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(document.activeElement).toBe(document.body);
  });

  it("does not announce an empty state, which is not a status change", () => {
    render(<StateNotice state="no-members" />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lets a screen replace the title to name the file that failed", () => {
    render(<StateNotice state="invalid-workbook" title='"July 2026" is not a valid workbook' />);

    expect(screen.getByText('"July 2026" is not a valid workbook')).toBeVisible();
    expect(screen.queryByText(describeSystemState("invalid-workbook").title)).toBeNull();
  });
});

describe("StateSkeleton", () => {
  it("reserves the final dimensions so nothing shifts when content arrives", () => {
    const { container } = render(
      <StateSkeleton label="Loading this month…" variant="card" width="18rem" height="6rem" />,
    );

    const skeleton = container.querySelector(".skeleton");
    expect(skeleton).toHaveClass("skeleton-card");
    expect(skeleton?.getAttribute("style")).toContain("--skeleton-w: 18rem");
    expect(skeleton?.getAttribute("style")).toContain("--skeleton-h: 6rem");
  });

  it("reserves one placeholder per row of final content", () => {
    const { container } = render(<StateSkeleton label="Loading members…" count={4} />);

    expect(container.querySelectorAll(".skeleton")).toHaveLength(4);
  });

  it("announces the wait politely without exposing the placeholder shapes", () => {
    const { container } = render(<StateSkeleton label="Loading your calendar…" />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Loading your calendar…");
    expect(container.querySelector(".skeleton-stack")).toHaveAttribute("aria-hidden", "true");
  });
});
