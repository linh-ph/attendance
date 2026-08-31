import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncStatus } from "./sync-status";
import { SYNC_STATE_ORDER, describeSyncState } from "./sync-state";

describe("SyncStatus", () => {
  it("announces through a polite live region", () => {
    render(<SyncStatus state="saved-locally" />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).not.toHaveAttribute("aria-live", "assertive");
  });

  it("never steals focus when it appears", () => {
    render(<SyncStatus state="syncing" />);

    expect(document.activeElement).toBe(document.body);
  });

  it("shows the spec word, its meaning, and the next action", () => {
    render(<SyncStatus state="offline" />);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Offline");
    expect(region).toHaveTextContent(describeSyncState("offline").detail);
    expect(region).toHaveTextContent(describeSyncState("offline").action);
  });

  it("carries the word inside the pill, so colour is never the only carrier", () => {
    const { container } = render(<SyncStatus state="synced" />);

    const pill = container.querySelector(".state-pill");
    expect(pill).not.toBeNull();
    expect(pill).toHaveClass("state-pill-synced");
    expect(pill).toHaveTextContent("Synced");
  });

  it.each(SYNC_STATE_ORDER)("renders %s as a word, not only a wash", (state) => {
    const { container } = render(<SyncStatus state={state} />);
    const descriptor = describeSyncState(state);

    expect(container.querySelector(".state-pill")).toHaveTextContent(descriptor.label);
    expect(screen.getByRole("status")).toHaveTextContent(descriptor.action);
  });

  it("promotes Needs attention to the failed pill for a provider failure", () => {
    const { container } = render(<SyncStatus state="needs-attention" cause="provider" />);

    expect(container.querySelector(".state-pill")).toHaveClass("state-pill-failed");
  });

  it("appends a caller detail after the vocabulary sentence", () => {
    render(<SyncStatus state="needs-attention" detail="Clock out must be after clock in." />);

    expect(screen.getByRole("status")).toHaveTextContent("Clock out must be after clock in.");
  });

  it("shows when the sheet was last checked without changing the state word", () => {
    render(<SyncStatus state="synced" lastCheckedLabel="Last checked 2 min ago" />);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Synced");
    expect(region).toHaveTextContent("Last checked 2 min ago");
  });

  it("drops the live region when a screen only wants the badge", () => {
    const { container } = render(<SyncStatus state="synced" announce={false} />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector(".state-pill")).toHaveTextContent("Synced");
  });

  it("exposes the state as data so a screen can style around it without re-deriving it", () => {
    const { container } = render(<SyncStatus state="remote-changes-detected" />);

    expect(container.querySelector("[data-sync-state]")).toHaveAttribute(
      "data-sync-state",
      "remote-changes-detected",
    );
  });
});
