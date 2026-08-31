import { describe, expect, it } from "vitest";
import { emptyDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { createCalendarCache, type CalendarCache } from "./calendar-cache";
import { buildCalendarSnapshot, type CalendarSnapshot } from "./calendar-state";
import {
  CALENDAR_STORE,
  CacheStorageError,
  createMemoryData,
  createMemoryEngine,
  type CacheEngine,
} from "./engine";
import type { CacheResult } from "./results";

const EMAIL = "linh.np@blended-asia.com";
const CHECKED_AT = "2026-07-06T01:00:00.000Z";

const view = (over: Partial<AttendanceMonthView> = {}): AttendanceMonthView => ({
  fileId: "file-1",
  sheetId: 101,
  sheetTitle: "Linh",
  month: "2026-07",
  spreadsheetTimeZone: "Asia/Tokyo",
  role: "employee",
  statuses: [],
  days: [emptyDay("2026-07-01"), emptyDay("2026-07-02")],
  ...over,
});

const snapshotOf = (over: Partial<AttendanceMonthView> = {}): CalendarSnapshot =>
  buildCalendarSnapshot({ email: EMAIL, view: view(over), checkedAt: CHECKED_AT });

const cacheWith = (engine: CacheEngine): CalendarCache =>
  createCalendarCache({ engine, now: () => CHECKED_AT });

const memoryCache = (): CalendarCache => cacheWith(createMemoryEngine());

function expectValue<T>(result: CacheResult<T>): T {
  if (!result.ok) throw new Error(`Expected a success, got ${JSON.stringify(result)}`);
  return result.value;
}

describe("calendar cache", () => {
  it("writes a snapshot and reads it back for the same context", async () => {
    const cache = memoryCache();
    const snapshot = snapshotOf();

    expect(expectValue(await cache.writeSnapshot(snapshot))).toEqual({ status: "written" });

    const read = expectValue<CalendarSnapshot | null>(
      await cache.readSnapshot({ email: EMAIL, fileId: "file-1", sheetId: "101", month: "2026-07" }),
    );

    expect(read?.month).toBe("2026-07");
    expect(read?.days).toHaveLength(2);
  });

  it("answers a miss with null rather than a failure", async () => {
    const read = await memoryCache().readSnapshot({
      email: EMAIL,
      fileId: "file-1",
      sheetId: "101",
      month: "2026-12",
    });

    expect(read).toEqual({ ok: true, value: null });
  });

  it("scopes snapshots by account, so two people in one browser profile never mix", async () => {
    const cache = memoryCache();
    await cache.writeSnapshot(snapshotOf());

    const other = await cache.readSnapshot({
      email: "someone.else@blended-asia.com",
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
    });

    expect(other).toEqual({ ok: true, value: null });
  });

  it("remembers which month the calendar is on, per account", async () => {
    const cache = memoryCache();
    await cache.writeSnapshot(snapshotOf());

    const pointer = expectValue<{ month: string; fileId: string } | null>(
      await cache.readPointer(EMAIL),
    );

    expect(pointer).toMatchObject({ month: "2026-07", fileId: "file-1", sheetId: "101" });
    expect(await cache.readPointer("someone.else@blended-asia.com")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("moves the pointer when the calendar loads another month", async () => {
    const cache = memoryCache();
    await cache.writeSnapshot(snapshotOf());
    await cache.writeSnapshot(snapshotOf({ month: "2026-08", days: [emptyDay("2026-08-01")] }));

    expect(expectValue(await cache.readPointer(EMAIL))?.month).toBe("2026-08");

    // The month it moved away from is still cached, so going back is instant.
    const previous = expectValue<CalendarSnapshot | null>(
      await cache.readSnapshot({ email: EMAIL, fileId: "file-1", sheetId: "101", month: "2026-07" }),
    );
    expect(previous?.month).toBe("2026-07");
  });

  it("reports a refused write instead of reporting success", async () => {
    const cache = cacheWith(
      createMemoryEngine({
        fail: ({ mode }) =>
          mode === "readwrite" ? new CacheStorageError("quota", "No space left.") : null,
      }),
    );

    expect(await cache.writeSnapshot(snapshotOf())).toEqual({
      ok: false,
      reason: "quota",
      message: "No space left.",
    });
  });

  it("refuses to store credential-shaped material", async () => {
    const cache = memoryCache();
    const poisoned = {
      ...snapshotOf(),
      accessToken: "ya29.a0AfH6SMB-secret",
    } as unknown as CalendarSnapshot;

    const result = await cache.writeSnapshot(poisoned);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden-content");
  });

  it("treats a record that fails its guard as corrupt and leaves it in place", async () => {
    const data = createMemoryData();
    const cache = cacheWith(createMemoryEngine({ data }));
    await cache.writeSnapshot(snapshotOf());

    const [key] = [...data.stores[CALENDAR_STORE].keys()].filter((name) => name.startsWith("cal"));
    data.stores[CALENDAR_STORE].set(key, { schemaVersion: 1, account: EMAIL, role: "manager" });

    const read = await cache.readSnapshot({
      email: EMAIL,
      fileId: "file-1",
      sheetId: "101",
      month: "2026-07",
    });

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("corrupt");
    expect(data.stores[CALENDAR_STORE].get(key)).toBeDefined();
  });

  it("clears one account's calendar records without touching another's", async () => {
    const cache = memoryCache();
    await cache.writeSnapshot(snapshotOf());
    await cache.writeSnapshot(
      buildCalendarSnapshot({
        email: "someone.else@blended-asia.com",
        view: view(),
        checkedAt: CHECKED_AT,
      }),
    );

    expect(expectValue<{ removed: number }>(await cache.clearAccount(EMAIL)).removed).toBe(2);

    expect(
      expectValue<CalendarSnapshot | null>(
        await cache.readSnapshot({
          email: EMAIL,
          fileId: "file-1",
          sheetId: "101",
          month: "2026-07",
        }),
      ),
    ).toBeNull();

    expect(
      expectValue<CalendarSnapshot | null>(
        await cache.readSnapshot({
          email: "someone.else@blended-asia.com",
          fileId: "file-1",
          sheetId: "101",
          month: "2026-07",
        }),
      ),
    ).not.toBeNull();
  });

  it("answers every call with a typed failure when there is no storage at all", async () => {
    const cache = createCalendarCache({ engine: null, now: () => CHECKED_AT });

    expect(await cache.readPointer(EMAIL)).toEqual({
      ok: false,
      reason: "unavailable",
      message: "This browser has no usable local storage.",
    });
    expect((await cache.writeSnapshot(snapshotOf())).ok).toBe(false);
  });
});
