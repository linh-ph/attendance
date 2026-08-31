import { describe, expect, it } from "vitest";
import {
  SYNC_STATE_ORDER,
  describeSyncState,
  syncAnnouncement,
  type SyncState,
} from "./sync-state";

/**
 * Spec §5.4 pins the eight labels word for word. A screen that phrases its own
 * status is the defect this table exists to prevent, so the labels are asserted
 * literally rather than derived from the implementation.
 */
const SPEC_LABELS: Record<SyncState, string> = {
  synced: "Synced",
  "saved-locally": "Saved locally",
  syncing: "Syncing",
  offline: "Offline",
  "needs-attention": "Needs attention",
  "remote-changes-detected": "Remote changes detected",
  "local-storage-unavailable": "Local storage unavailable",
  "saved-remote-cache-unavailable": "Saved to Google Sheets · local cache unavailable",
};

describe("sync state vocabulary", () => {
  it("publishes exactly the eight states from spec 5.4", () => {
    expect([...SYNC_STATE_ORDER]).toEqual([
      "synced",
      "saved-locally",
      "syncing",
      "offline",
      "needs-attention",
      "remote-changes-detected",
      "local-storage-unavailable",
      "saved-remote-cache-unavailable",
    ]);
  });

  it.each(SYNC_STATE_ORDER)("labels %s exactly as the spec words it", (state) => {
    expect(describeSyncState(state).label).toBe(SPEC_LABELS[state]);
  });

  it("gives every state a meaning and a next action, so a pill is never only a colour", () => {
    for (const state of SYNC_STATE_ORDER) {
      const descriptor = describeSyncState(state);
      expect(descriptor.detail.length).toBeGreaterThan(0);
      expect(descriptor.action.length).toBeGreaterThan(0);
    }
  });

  it("maps each state onto a published F1 pill class", () => {
    const pillClasses = SYNC_STATE_ORDER.map((state) => describeSyncState(state).pillClass);

    expect(pillClasses).toEqual([
      "state-pill-synced",
      "state-pill-pending",
      "state-pill-busy",
      "state-pill-attention",
      "state-pill-attention",
      "state-pill-attention",
      "state-pill-pending",
      "state-pill-pending",
    ]);
  });

  it("sharpens Needs attention to the failed pill for a provider or auth cause", () => {
    expect(describeSyncState("needs-attention", "provider").pillClass).toBe("state-pill-failed");
    expect(describeSyncState("needs-attention", "authentication").pillClass).toBe(
      "state-pill-failed",
    );
    expect(describeSyncState("needs-attention", "validation").pillClass).toBe(
      "state-pill-attention",
    );
    expect(describeSyncState("needs-attention", "conflict").pillClass).toBe("state-pill-attention");
  });

  it("leaves every other state's tone untouched by a cause", () => {
    for (const state of SYNC_STATE_ORDER) {
      if (state === "needs-attention") continue;
      expect(describeSyncState(state, "provider").pillClass).toBe(
        describeSyncState(state).pillClass,
      );
    }
  });

  it("reproduces the composite sentence spec 5.3 requires for a rejected draft write", () => {
    expect(syncAnnouncement("local-storage-unavailable")).toBe(
      "Local storage unavailable — keep this page open or save to Google Sheets.",
    );
  });

  it("announces Synced with its meaning rather than an invented action", () => {
    expect(syncAnnouncement("synced")).toBe("Synced — this month matches Google Sheets.");
  });

  it("never tells the reader to save the same day to Google Sheets twice", () => {
    const descriptor = describeSyncState("saved-remote-cache-unavailable");

    expect(descriptor.detail).toContain("Google Sheets has your change");
    expect(descriptor.action).toContain("Do not save to Google Sheets again");
  });
});
