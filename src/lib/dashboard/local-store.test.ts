import { describe, expect, it } from "vitest";
import type { AttendanceDay } from "@/lib/attendance/model";
import { createMemoryStore, createNullStore } from "./local-store";
import type { RecentFile } from "./local-records";

const day = (over: Partial<AttendanceDay> = {}) =>
  ({ date: "2026-07-03", clockIn: 8, clockOut: 17.5, breakHours: 1, ...over }) as AttendanceDay;

const recent = (over: Partial<RecentFile> = {}): RecentFile => ({
  fileId: "file-1",
  sheetId: "101",
  name: "202607勤怠管理表",
  sheetTitle: "NGUYEN PHAN LINH",
  openedAt: "2026-08-29T00:00:00.000Z",
  ...over,
});

describe("local store contract", () => {
  it("round-trips a draft and clears it once the day is saved", async () => {
    const store = createMemoryStore();

    expect(await store.readDraft("a@b.com", "file-1", "101", "2026-07-03")).toBe(null);

    await store.writeDraft("a@b.com", "file-1", "101", "2026-07-03", { day: day(), baseline: day() });
    expect(await store.readDraft("a@b.com", "file-1", "101", "2026-07-03")).toEqual({ day: day(), baseline: day() });

    await store.clearDraft("a@b.com", "file-1", "101", "2026-07-03");
    expect(await store.readDraft("a@b.com", "file-1", "101", "2026-07-03")).toBe(null);
  });

  it("never lets one signed-in account read another's draft on a shared browser", async () => {
    const store = createMemoryStore();

    await store.writeDraft("first@b.com", "file-1", "101", "2026-07-03", { day: day({ clockIn: 8 }), baseline: day() });
    await store.writeDraft("second@b.com", "file-1", "101", "2026-07-03", { day: day({ clockIn: 9 }), baseline: day() });

    expect(
      (await store.readDraft("first@b.com", "file-1", "101", "2026-07-03"))?.day,
    ).toEqual(day({ clockIn: 8 }));
    expect(
      (await store.readDraft("second@b.com", "file-1", "101", "2026-07-03"))?.day,
    ).toEqual(day({ clockIn: 9 }));
  });

  it("treats the same address in different casing as the same account", async () => {
    const store = createMemoryStore();

    await store.writeDraft("Linh.NP@Blended-Asia.com", "file-1", "101", "2026-07-03", { day: day(), baseline: day() });

    expect(
      (await store.readDraft("linh.np@blended-asia.com", "file-1", "101", "2026-07-03"))?.day,
    ).toEqual(day());
  });

  it("keeps a month cache per sheet and returns the newest write", async () => {
    const store = createMemoryStore();
    const view = { month: "2026-07", days: [] } as never;

    expect(await store.readMonth("a@b.com", "file-1", "101")).toBe(null);

    await store.writeMonth("a@b.com", "file-1", "101", view);
    expect(await store.readMonth("a@b.com", "file-1", "101")).toEqual(view);
    expect(await store.readMonth("a@b.com", "file-1", "102")).toBe(null);
  });

  it("returns the recent list newest first and scoped to the account", async () => {
    const store = createMemoryStore();

    await store.addRecent("a@b.com", recent({ fileId: "one" }));
    const list = await store.addRecent("a@b.com", recent({ fileId: "two" }));

    expect(list.map((entry) => entry.fileId)).toEqual(["two", "one"]);
    expect(await store.readRecent("a@b.com")).toEqual(list);
    expect(await store.readRecent("other@b.com")).toEqual([]);
  });
});

describe("roster", () => {
  it("keeps members per signed-in account, so a shared profile never mixes them", async () => {
    const store = createMemoryStore();

    await store.addMember("linh.np@blended-asia.com", {
      email: "han.tg@blended-asia.com",
      displayName: "THAI GIA HAN",
    });

    expect(await store.readMembers("linh.np@blended-asia.com")).toEqual([
      { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" },
    ]);
    expect(await store.readMembers("someone.else@blended-asia.com")).toEqual([]);
  });

  it("treats the address as the identity, so a corrected name replaces the row", async () => {
    const store = createMemoryStore();

    await store.addMember("linh.np@blended-asia.com", {
      email: "han.tg@blended-asia.com",
      displayName: "HAN",
    });
    const roster = await store.addMember("linh.np@blended-asia.com", {
      email: "han.tg@blended-asia.com",
      displayName: "THAI GIA HAN",
    });

    expect(roster).toEqual([{ email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" }]);
  });

  it("orders by name, so the list reads the same on every visit", async () => {
    const store = createMemoryStore();
    const owner = "linh.np@blended-asia.com";

    await store.addMember(owner, { email: "thao.nht@blended-asia.com", displayName: "NGUYEN HO TRONG THAO" });
    await store.addMember(owner, { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" });
    const roster = await store.addMember(owner, {
      email: "hieu.ntn@blended-asia.com",
      displayName: "NGUYEN THI NHU HIEU",
    });

    expect(roster.map((member) => member.displayName)).toEqual([
      "NGUYEN HO TRONG THAO",
      "NGUYEN THI NHU HIEU",
      "THAI GIA HAN",
    ]);
  });

  it("removes one member and leaves the rest", async () => {
    const store = createMemoryStore();
    const owner = "linh.np@blended-asia.com";

    await store.addMember(owner, { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" });
    await store.addMember(owner, { email: "hieu.ntn@blended-asia.com", displayName: "HIEU" });

    expect(await store.removeMember(owner, "han.tg@blended-asia.com")).toEqual([
      { email: "hieu.ntn@blended-asia.com", displayName: "HIEU" },
    ]);
  });
});

describe("null store", () => {
  it("accepts every write and reports nothing, so the editor still works without storage", async () => {
    const store = createNullStore();

    await store.writeDraft("a@b.com", "file-1", "101", "2026-07-03", { day: day(), baseline: day() });
    await store.writeMonth("a@b.com", "file-1", "101", { month: "2026-07" } as never);

    expect(await store.readDraft("a@b.com", "file-1", "101", "2026-07-03")).toBe(null);
    expect(await store.readMonth("a@b.com", "file-1", "101")).toBe(null);
    expect(await store.readRecent("a@b.com")).toEqual([]);
  });
});
