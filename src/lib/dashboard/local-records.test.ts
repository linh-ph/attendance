import { describe, expect, it } from "vitest";
import {
  addRecentFile,
  draftKey,
  isDraftRecord,
  isMonthCacheRecord,
  isRecentFile,
  monthCacheKey,
  RECENT_FILE_LIMIT,
  scopeKey,
  type RecentFile,
} from "./local-records";

const recent = (over: Partial<RecentFile> = {}): RecentFile => ({
  fileId: "file-1",
  sheetId: "101",
  name: "202607勤怠管理表",
  sheetTitle: "NGUYEN PHAN LINH",
  openedAt: "2026-08-29T00:00:00.000Z",
  ...over,
});

describe("keys", () => {
  it("scopes every key to the normalized email so two accounts never collide", () => {
    expect(scopeKey("  LINH.NP@Blended-Asia.com ")).toBe("linh.np@blended-asia.com");
    expect(draftKey("LINH.NP@Blended-Asia.com", "file-1", "101", "2026-07-03")).toBe(
      draftKey("linh.np@blended-asia.com", "file-1", "101", "2026-07-03"),
    );
  });

  it("keeps drafts for different days, sheets, and files apart", () => {
    const base = draftKey("a@b.com", "file-1", "101", "2026-07-03");
    expect(base).not.toBe(draftKey("a@b.com", "file-1", "101", "2026-07-04"));
    expect(base).not.toBe(draftKey("a@b.com", "file-1", "102", "2026-07-03"));
    expect(base).not.toBe(draftKey("a@b.com", "file-2", "101", "2026-07-03"));
    expect(base).not.toBe(draftKey("z@b.com", "file-1", "101", "2026-07-03"));
  });

  it("keeps the month cache separate per sheet", () => {
    expect(monthCacheKey("a@b.com", "file-1", "101")).not.toBe(
      monthCacheKey("a@b.com", "file-1", "102"),
    );
  });
});

describe("addRecentFile", () => {
  it("puts the newest entry first", () => {
    const list = addRecentFile([recent({ fileId: "old" })], recent({ fileId: "new" }));
    expect(list.map((entry) => entry.fileId)).toEqual(["new", "old"]);
  });

  it("re-opening a file moves it to the front instead of duplicating it", () => {
    const list = addRecentFile(
      [recent({ fileId: "a" }), recent({ fileId: "b" }), recent({ fileId: "c" })],
      recent({ fileId: "c", openedAt: "2026-08-30T00:00:00.000Z" }),
    );

    expect(list.map((entry) => entry.fileId)).toEqual(["c", "a", "b"]);
    expect(list[0].openedAt).toBe("2026-08-30T00:00:00.000Z");
  });

  it("treats two sheets of the same file as different entries", () => {
    const list = addRecentFile([recent({ sheetId: "101" })], recent({ sheetId: "102" }));
    expect(list).toHaveLength(2);
  });

  it("caps the list so storage cannot grow without bound", () => {
    let list: RecentFile[] = [];
    for (let index = 0; index < RECENT_FILE_LIMIT + 5; index += 1) {
      list = addRecentFile(list, recent({ fileId: `file-${index}` }));
    }

    expect(list).toHaveLength(RECENT_FILE_LIMIT);
    expect(list[0].fileId).toBe(`file-${RECENT_FILE_LIMIT + 4}`);
  });

  it("never mutates the list it was given", () => {
    const original = [recent({ fileId: "a" })];
    const frozen = Object.freeze([...original]);

    expect(() => addRecentFile(frozen, recent({ fileId: "b" }))).not.toThrow();
    expect(original).toHaveLength(1);
  });
});

describe("stored value guards", () => {
  it("accepts well-formed records", () => {
    expect(isRecentFile(recent())).toBe(true);
    expect(
      isDraftRecord({ email: "a@b.com", day: { date: "2026-07-03" }, baseline: {} }),
    ).toBe(true);
    expect(isMonthCacheRecord({ email: "a@b.com", view: { month: "2026-07" } })).toBe(true);
  });

  it("rejects anything a corrupted or foreign store could hand back", () => {
    for (const value of [null, undefined, 42, "text", [], {}, { fileId: "" }]) {
      expect(isRecentFile(value)).toBe(false);
    }

    expect(isDraftRecord({ email: "a@b.com" })).toBe(false);
    // A draft without the baseline it was made against must never be restored.
    expect(isDraftRecord({ email: "a@b.com", day: { date: "2026-07-03" } })).toBe(false);
    expect(isMonthCacheRecord({ view: { month: "2026-07" } })).toBe(false);
  });
});
