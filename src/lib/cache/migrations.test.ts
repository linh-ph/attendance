import { describe, expect, it } from "vitest";
import { draftCacheKey, monthCacheKey, type CacheContext } from "./keys";
import { draftKeysForContext, monthKeysForContext, planMigration } from "./migrations";

const context: CacheContext = {
  email: "linh.np@blended-asia.com",
  fileId: "file-1",
  sheetId: "101",
  month: "2026-07",
};

describe("planMigration", () => {
  it("does nothing when the stored version is the target version", () => {
    expect(planMigration({ storedSchemaVersion: 3, targetSchemaVersion: 3, pendingDraftDates: [] })).toEqual({
      action: "none",
    });
  });

  it("does nothing when nothing is stored at all", () => {
    expect(planMigration({ storedSchemaVersion: null, targetSchemaVersion: 3, pendingDraftDates: [] })).toEqual({
      action: "none",
    });
  });

  it("replaces a clean cache written under an older schema version", () => {
    expect(planMigration({ storedSchemaVersion: 1, targetSchemaVersion: 3, pendingDraftDates: [] })).toEqual({
      action: "replace-clean",
    });
  });

  it("replaces a clean cache written under a newer schema version it cannot read", () => {
    expect(planMigration({ storedSchemaVersion: 9, targetSchemaVersion: 3, pendingDraftDates: [] })).toEqual({
      action: "replace-clean",
    });
  });

  it("refuses rather than deleting a pending draft it cannot carry across versions", () => {
    expect(
      planMigration({
        storedSchemaVersion: 1,
        targetSchemaVersion: 3,
        pendingDraftDates: ["2026-07-03", "2026-07-04"],
      }),
    ).toEqual({
      action: "refuse",
      reason: "pending-draft",
      preservedDates: ["2026-07-03", "2026-07-04"],
    });
  });
});

describe("scanning stored keys for one context", () => {
  const keys = [
    monthCacheKey(context, 1),
    monthCacheKey(context, 2),
    monthCacheKey({ ...context, month: "2026-08" }, 1),
    monthCacheKey({ ...context, email: "other@b.com" }, 1),
    draftCacheKey(context, "2026-07-03", 1),
    draftCacheKey(context, "2026-07-04", 2),
    draftCacheKey({ ...context, sheetId: "102" }, "2026-07-03", 1),
    "not-a-cache-key",
  ];

  it("finds this context's month records under every schema version", () => {
    expect(monthKeysForContext(keys, context).map((entry) => entry.schemaVersion).sort()).toEqual([1, 2]);
  });

  it("finds this context's drafts under every schema version, and nobody else's", () => {
    const found = draftKeysForContext(keys, context);

    expect(found.map((entry) => entry.date).sort()).toEqual(["2026-07-03", "2026-07-04"]);
    expect(found.every((entry) => entry.account === "linh.np@blended-asia.com")).toBe(true);
  });

  it("excludes the target schema version when asked, so only foreign records are considered", () => {
    expect(draftKeysForContext(keys, context, { excludeSchemaVersion: 1 }).map((entry) => entry.date)).toEqual([
      "2026-07-04",
    ]);
  });
});
