import { describe, expect, it } from "vitest";
import { SYSTEM_STATE_ORDER, describeSystemState } from "./state-catalog";

describe("system state catalog", () => {
  it("covers exactly the fourteen states spec 8.2 requires", () => {
    expect([...SYSTEM_STATE_ORDER]).toEqual([
      "first-load",
      "revalidating",
      "local-storage-unavailable",
      "no-timesheet",
      "no-managed-files",
      "no-members",
      "folder-unavailable",
      "offline-local-safe",
      "local-changes-pending",
      "remote-changes-detected",
      "authentication-expired",
      "provider-failure",
      "partial-setup",
      "invalid-workbook",
    ]);
  });

  it.each(SYSTEM_STATE_ORDER)(
    "%s answers what happened, whether the data is safe, and what to do next",
    (id) => {
      const state = describeSystemState(id);

      expect(state.title.length).toBeGreaterThan(0);
      expect(state.dataSafety.length).toBeGreaterThan(0);
      expect(state.guidance.length).toBeGreaterThan(0);
    },
  );

  it("keeps one broken file at card scope so it cannot fail a whole page", () => {
    expect(describeSystemState("invalid-workbook").scope).toBe("card");
    expect(describeSystemState("partial-setup").scope).toBe("card");
  });

  it("gives a page-level failure page-level recovery", () => {
    expect(describeSystemState("provider-failure").scope).toBe("page");
    expect(describeSystemState("provider-failure").recovery).toContain("retry");

    expect(describeSystemState("authentication-expired").scope).toBe("page");
    expect(describeSystemState("authentication-expired").recovery).toContain("reauthenticate");
  });

  it("offers Resume, and only Resume, for a partial create/import/setup", () => {
    expect(describeSystemState("partial-setup").recovery).toEqual(["resume"]);
  });

  it("offers a reload for a sheet that moved under the current baseline", () => {
    expect(describeSystemState("remote-changes-detected").recovery).toContain("reload");
  });

  it("says the local data is safe whenever it is", () => {
    for (const id of [
      "offline-local-safe",
      "local-changes-pending",
      "remote-changes-detected",
    ] as const) {
      expect(describeSystemState(id).dataSafety.toLowerCase()).toContain("safe");
    }
  });

  it("refuses to claim durability when the draft was never persisted", () => {
    const state = describeSystemState("local-storage-unavailable");

    expect(state.dataSafety).not.toMatch(/saved locally|saved in your browser/i);
    expect(state.guidance).toContain("Keep this page open");
  });

  it("carries every state's tone onto a published F1 pill class", () => {
    const allowed = new Set([
      "state-pill",
      "state-pill-neutral",
      "state-pill-synced",
      "state-pill-pending",
      "state-pill-attention",
      "state-pill-failed",
      "state-pill-busy",
    ]);

    for (const id of SYSTEM_STATE_ORDER) {
      expect(allowed.has(describeSystemState(id).pillClass)).toBe(true);
    }
  });

  it("treats the three empties as empties, not as failures", () => {
    for (const id of ["no-timesheet", "no-managed-files", "no-members"] as const) {
      expect(describeSystemState(id).kind).toBe("empty");
      expect(describeSystemState(id).recovery).toEqual([]);
    }
  });

  it("treats the two waiting states as loading", () => {
    expect(describeSystemState("first-load").kind).toBe("loading");
    expect(describeSystemState("revalidating").kind).toBe("loading");
  });
});
