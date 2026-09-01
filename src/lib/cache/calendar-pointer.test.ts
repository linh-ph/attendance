import { describe, expect, it } from "vitest";
import {
  calendarPointerKey,
  createCalendarPointerStore,
  isCalendarPointer,
  type CalendarPointerStore,
} from "./calendar-pointer";
import {
  CALENDAR_STORE,
  CacheStorageError,
  createMemoryData,
  createMemoryEngine,
} from "./engine";

const EMAIL = "linh.np@blended-asia.com";
const NOW = "2026-07-06T01:00:00.000Z";

const store = (engine = createMemoryEngine()): CalendarPointerStore =>
  createCalendarPointerStore({ engine, now: () => NOW });

const input = { email: EMAIL, fileId: "file-1", sheetId: "101", month: "2026-07" };

describe("calendar pointer", () => {
  it("remembers the file, tab, and month the calendar was last on", async () => {
    const pointers = store();

    expect(await pointers.write(input)).toMatchObject({ ok: true });

    const read = await pointers.read(EMAIL);
    expect(read).toMatchObject({
      ok: true,
      value: { fileId: "file-1", sheetId: "101", month: "2026-07", updatedAt: NOW },
    });
  });

  it("answers an unknown account with null rather than a failure", async () => {
    expect(await store().read(EMAIL)).toEqual({ ok: true, value: null });
  });

  it("scopes the record by normalized account", async () => {
    const pointers = store();
    await pointers.write({ ...input, email: "  Linh.NP@Blended-Asia.com " });

    expect(await pointers.read(EMAIL)).toMatchObject({ ok: true, value: { month: "2026-07" } });
    expect(await pointers.read("someone.else@blended-asia.com")).toEqual({ ok: true, value: null });
  });

  it("moves when the calendar moves", async () => {
    const pointers = store();
    await pointers.write(input);
    await pointers.write({ ...input, month: "2026-08" });

    expect(await pointers.read(EMAIL)).toMatchObject({ ok: true, value: { month: "2026-08" } });
  });

  it("stores no authorization result — a cached role must be unreadable", async () => {
    const pointers = store();
    const written = await pointers.write(input);

    expect(written.ok).toBe(true);
    if (written.ok) expect(JSON.stringify(written.value)).not.toContain("role");
  });

  it("reports a refused write instead of reporting success", async () => {
    const pointers = store(
      createMemoryEngine({
        fail: ({ mode }) =>
          mode === "readwrite" ? new CacheStorageError("quota", "No space left.") : null,
      }),
    );

    expect(await pointers.write(input)).toEqual({
      ok: false,
      reason: "quota",
      message: "No space left.",
    });
  });

  it("treats a record that fails its guard as corrupt and leaves it in place", async () => {
    const data = createMemoryData();
    const pointers = store(createMemoryEngine({ data }));
    await pointers.write(input);

    const key = calendarPointerKey(EMAIL);
    data.stores[CALENDAR_STORE].set(key, { account: EMAIL, role: "manager" });

    const read = await pointers.read(EMAIL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("corrupt");
    expect(data.stores[CALENDAR_STORE].get(key)).toBeDefined();
  });

  it("forgets one account without touching another", async () => {
    const pointers = store();
    await pointers.write(input);
    await pointers.write({ ...input, email: "someone.else@blended-asia.com" });

    await pointers.clear(EMAIL);

    expect(await pointers.read(EMAIL)).toEqual({ ok: true, value: null });
    expect(await pointers.read("someone.else@blended-asia.com")).toMatchObject({ ok: true });
  });

  it("answers every call with a typed failure when there is no storage at all", async () => {
    const pointers = createCalendarPointerStore({ engine: null, now: () => NOW });

    expect(await pointers.read(EMAIL)).toEqual({
      ok: false,
      reason: "unavailable",
      message: "This browser has no usable local storage.",
    });
    expect((await pointers.write(input)).ok).toBe(false);
  });
});

describe("tab choices", () => {
  it("keeps one answer per file, not one per account", async () => {
    const pointers = store();

    await pointers.writeTabChoice(EMAIL, "file-july", "11");
    await pointers.writeTabChoice(EMAIL, "file-august", "22");

    expect(await pointers.readTabChoice(EMAIL, "file-july")).toMatchObject({
      ok: true,
      value: { sheetId: "11" },
    });
    // The second answer must not have displaced the first — that is the whole
    // reason this is not stored on the single pointer record.
    expect(await pointers.readTabChoice(EMAIL, "file-august")).toMatchObject({
      ok: true,
      value: { sheetId: "22" },
    });
  });

  it("answers null for a file never answered for", async () => {
    expect(await store().readTabChoice(EMAIL, "file-unknown")).toEqual({ ok: true, value: null });
  });

  it("scopes answers by account", async () => {
    const pointers = store();
    await pointers.writeTabChoice("Linh.NP@Blended-Asia.com", "file-1", "11");

    expect(await pointers.readTabChoice(EMAIL, "file-1")).toMatchObject({
      ok: true,
      value: { sheetId: "11" },
    });
    expect(await pointers.readTabChoice("someone.else@blended-asia.com", "file-1")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("does not collide with the pointer record", async () => {
    const pointers = store();
    await pointers.write(input);
    await pointers.writeTabChoice(EMAIL, "file-1", "77");

    expect(await pointers.read(EMAIL)).toMatchObject({ ok: true, value: { sheetId: "101" } });
    expect(await pointers.readTabChoice(EMAIL, "file-1")).toMatchObject({
      ok: true,
      value: { sheetId: "77" },
    });
  });

  it("reports a refused write instead of reporting success", async () => {
    const pointers = store(
      createMemoryEngine({
        fail: ({ mode }) =>
          mode === "readwrite" ? new CacheStorageError("quota", "No space left.") : null,
      }),
    );

    expect((await pointers.writeTabChoice(EMAIL, "file-1", "11")).ok).toBe(false);
  });
});

describe("isCalendarPointer", () => {
  it("refuses anything that is not one", () => {
    expect(isCalendarPointer(null)).toBe(false);
    expect(isCalendarPointer({ account: EMAIL })).toBe(false);
  });
});
