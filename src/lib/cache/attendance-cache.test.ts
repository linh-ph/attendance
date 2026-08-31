import { describe, expect, it } from "vitest";
import { emptyDay, type AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import { createAttendanceCache, createUnavailableCache, type AttendanceCache } from "./attendance-cache";
import { createMemoryBroadcastHub } from "./broadcast";
import {
  CACHE_DRAFT_STORE,
  CACHE_MONTH_STORE,
  CacheStorageError,
  createMemoryData,
  createMemoryEngine,
  type CacheEngine,
  type MemoryData,
} from "./engine";
import { CACHE_SCHEMA_VERSION, draftCacheKey, monthCacheKey, type CacheContext } from "./keys";
import type { CacheResult } from "./results";

/* -------------------------------------------------------------------------- */
/* Fixtures and assertions                                                     */
/* -------------------------------------------------------------------------- */

const CONTEXT: CacheContext = {
  email: "Linh.NP@Blended-Asia.com",
  fileId: "file-1",
  sheetId: "101",
  month: "2026-07",
};

const CHECKED_AT = "2026-08-31T00:00:00.000Z";

function day(date: string, over: Partial<AttendanceDay> = {}): AttendanceDay {
  return { ...emptyDay(date), ...over };
}

function view(days: AttendanceDay[]): AttendanceMonthView {
  return {
    fileId: "file-1",
    sheetId: 101,
    sheetTitle: "NGUYEN PHAN LINH",
    month: "2026-07",
    role: "employee",
    statuses: [],
    days,
  };
}

const REMOTE_DAYS = [day("2026-07-03"), day("2026-07-10")];

/** Unwraps an acknowledged success, failing the test with the typed reason. */
async function expectOk<T>(result: Promise<CacheResult<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`expected success, got ${settled.reason}: ${settled.message}`);
  return settled.value;
}

/** Narrows a discriminated outcome, so a wrong branch fails loudly, not silently. */
function expectStatus<T extends { status: string }, S extends T["status"]>(
  outcome: T,
  status: S,
): Extract<T, { status: S }> {
  expect(outcome.status).toBe(status);
  return outcome as Extract<T, { status: S }>;
}

function cacheWith(engine: CacheEngine): AttendanceCache {
  return createAttendanceCache({ engine, now: () => CHECKED_AT });
}

function freshCache(): AttendanceCache {
  return cacheWith(createMemoryEngine());
}

function rejectingCache(): AttendanceCache {
  return cacheWith(
    createMemoryEngine({
      fail: ({ mode }) => (mode === "readwrite" ? new CacheStorageError("quota", "disk full") : null),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Acknowledged results                                                        */
/* -------------------------------------------------------------------------- */

describe("every operation is acknowledged", () => {
  it("reports a cache miss as a success carrying null, so the caller falls back to the remote load", async () => {
    const cache = freshCache();

    expect(await cache.readMonth(CONTEXT)).toEqual({ ok: true, value: null });
    expect(await cache.readDraft(CONTEXT, "2026-07-03")).toEqual({ ok: true, value: null });
  });

  it("round-trips a month baseline with a revision, a checked-at time, and per-date hashes", async () => {
    const cache = freshCache();

    const written = expectStatus(
      await expectOk(cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT })),
      "written",
    );
    expect(written.record.revision).toBe(1);

    const stored = await expectOk(cache.readMonth(CONTEXT));

    expect(stored?.revision).toBe(1);
    expect(stored?.checkedAt).toBe(CHECKED_AT);
    expect(stored?.account).toBe("linh.np@blended-asia.com");
    expect(stored?.view.days).toHaveLength(2);
    expect(Object.keys(stored?.baselineHashes ?? {})).toEqual(["2026-07-03", "2026-07-10"]);
  });

  it("returns a typed failure instead of a false success when the browser rejects the write", async () => {
    const cache = rejectingCache();

    expect(
      await cache.writeDraft(CONTEXT, "2026-07-03", {
        day: day("2026-07-03", { clockIn: 8 }),
        baseline: day("2026-07-03"),
      }),
    ).toEqual({ ok: false, reason: "quota", message: "disk full" });

    expect(await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT })).toMatchObject({
      ok: false,
      reason: "quota",
    });
  });

  it("reports a corrupt record rather than pretending the cache is empty", async () => {
    const engine = createMemoryEngine();

    await engine.transact([CACHE_MONTH_STORE, CACHE_DRAFT_STORE], "readwrite", async (tx) => {
      await tx.put(CACHE_MONTH_STORE, monthCacheKey(CONTEXT), { nonsense: true });
      await tx.put(CACHE_DRAFT_STORE, draftCacheKey(CONTEXT, "2026-07-03"), 42);
    });

    expect(await cacheWith(engine).readMonth(CONTEXT)).toMatchObject({ ok: false, reason: "corrupt" });
    expect(await cacheWith(engine).readDraft(CONTEXT, "2026-07-03")).toMatchObject({
      ok: false,
      reason: "corrupt",
    });
  });

  it("answers every call with an explicit unavailable failure when there is no storage at all", async () => {
    const cache = createUnavailableCache("unavailable", "IndexedDB is not available in this browser.");

    const results = [
      await cache.readMonth(CONTEXT),
      await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT }),
      await cache.readDraft(CONTEXT, "2026-07-03"),
      await cache.writeDraft(CONTEXT, "2026-07-03", {
        day: day("2026-07-03"),
        baseline: day("2026-07-03"),
      }),
      await cache.clearDraft(CONTEXT, "2026-07-03"),
      await cache.restoreDraft(CONTEXT, "2026-07-03", day("2026-07-03")),
      await cache.commitSave(CONTEXT, {
        date: "2026-07-03",
        confirmedDay: day("2026-07-03"),
        sentRevision: 1,
        checkedAt: CHECKED_AT,
      }),
      await cache.migrate(CONTEXT),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

describe("no credential material can be stored", () => {
  it("refuses a month whose payload carries a token-shaped property and writes nothing", async () => {
    const data = createMemoryData();
    const cache = cacheWith(createMemoryEngine({ data }));

    const poisoned = { ...view(REMOTE_DAYS), accessToken: "ya29.secret" } as unknown as AttendanceMonthView;

    expect(await cache.writeMonth(CONTEXT, { view: poisoned, checkedAt: CHECKED_AT })).toMatchObject({
      ok: false,
      reason: "forbidden-content",
    });
    expect(data.stores[CACHE_MONTH_STORE].size).toBe(0);
  });

  it("stores the month without the authorization result the server returned", async () => {
    const data = createMemoryData();
    const cache = cacheWith(createMemoryEngine({ data }));

    // The caller hands over the whole server response, role and all.
    const written = expectStatus(
      await expectOk(cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT })),
      "written",
    );

    expect("role" in written.record.view).toBe(false);
    expect(JSON.stringify([...data.stores[CACHE_MONTH_STORE].values()])).not.toContain("employee");

    const read = await expectOk(cache.readMonth(CONTEXT));
    expect(read).not.toBe(null);
    expect("role" in (read?.view ?? {})).toBe(false);
    // The attendance data itself is untouched.
    expect(read?.view.days).toHaveLength(2);
    expect(read?.view.sheetTitle).toBe("NGUYEN PHAN LINH");
  });

  it("refuses to read back a record that somehow carries a role, rather than returning one", async () => {
    const engine = createMemoryEngine();

    await engine.transact([CACHE_MONTH_STORE], "readwrite", (tx) =>
      tx.put(CACHE_MONTH_STORE, monthCacheKey(CONTEXT), {
        schemaVersion: CACHE_SCHEMA_VERSION,
        account: "linh.np@blended-asia.com",
        fileId: "file-1",
        sheetId: "101",
        month: "2026-07",
        revision: 1,
        checkedAt: CHECKED_AT,
        view: view(REMOTE_DAYS),
        baselineHashes: {},
      }),
    );

    expect(await cacheWith(engine).readMonth(CONTEXT)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses a draft whose value looks like an OAuth token and writes nothing", async () => {
    const data = createMemoryData();
    const cache = cacheWith(createMemoryEngine({ data }));

    const result = await cache.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { notes: "ya29.a0AfH6SMBnot-real" }),
      baseline: day("2026-07-03"),
    });

    expect(result).toMatchObject({ ok: false, reason: "forbidden-content" });
    expect(data.stores[CACHE_DRAFT_STORE].size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Epochs                                                                      */
/* -------------------------------------------------------------------------- */

describe("request epochs", () => {
  it("refuses a response whose epoch is no longer the latest issued for its context", async () => {
    const cache = freshCache();

    const stale = cache.select(CONTEXT);
    cache.issue(CONTEXT); // a newer revalidation started

    const outcome = await expectOk(
      cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT, epoch: stale }),
    );

    expect(expectStatus(outcome, "superseded").reason).toBe("stale-epoch");
    expect(await cache.readMonth(CONTEXT)).toEqual({ ok: true, value: null });
  });

  it("refuses a response for a context the user has navigated away from", async () => {
    const cache = freshCache();

    const epoch = cache.select(CONTEXT);
    cache.select({ ...CONTEXT, sheetId: "102" });

    const outcome = await expectOk(
      cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT, epoch }),
    );

    expect(expectStatus(outcome, "superseded").reason).toBe("stale-epoch");
  });

  it("accepts the latest epoch of the selected context", async () => {
    const cache = freshCache();
    const epoch = cache.select(CONTEXT);

    const outcome = await expectOk(
      cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT, epoch }),
    );

    expectStatus(outcome, "written");
  });
});

/* -------------------------------------------------------------------------- */
/* Race 1 — a slow revalidation arriving after a successful Save               */
/* -------------------------------------------------------------------------- */

describe("a revalidation started before a Save cannot replace the post-Save baseline", () => {
  it("refuses the late write and keeps the confirmed row", async () => {
    const cache = freshCache();

    await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT });

    // The revalidation captures what it saw before its fetch began.
    const captured = (await expectOk(cache.readMonth(CONTEXT)))?.revision ?? null;
    expect(captured).toBe(1);

    const commit = await expectOk(
      cache.commitSave(CONTEXT, {
        date: "2026-07-03",
        confirmedDay: day("2026-07-03", { clockIn: 8, clockOut: 17.5, breakHours: 1 }),
        sentRevision: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    expect(commit.monthUpdated).toBe(true);
    expect(commit.monthRevision).toBe(2);

    // Only now does the slow revalidation resolve, carrying the pre-save month.
    const late = await expectOk(
      cache.writeMonth(CONTEXT, {
        view: view(REMOTE_DAYS),
        checkedAt: CHECKED_AT,
        expectedRevision: captured,
      }),
    );

    expect(expectStatus(late, "superseded").reason).toBe("revision-advanced");

    const stored = await expectOk(cache.readMonth(CONTEXT));
    expect(stored?.revision).toBe(2);
    expect(stored?.view.days.find((entry) => entry.date === "2026-07-03")?.clockIn).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/* Race 2 — an edit made while a Save was in flight                            */
/* -------------------------------------------------------------------------- */

describe("a Save clears only the draft revision it sent", () => {
  it("keeps an edit made during the Save pending, and clears it once that revision is sent", async () => {
    const cache = freshCache();
    await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT });

    const sent = expectStatus(
      await expectOk(
        cache.writeDraft(CONTEXT, "2026-07-03", {
          day: day("2026-07-03", { clockIn: 8 }),
          baseline: day("2026-07-03"),
        }),
      ),
      "written",
    );
    expect(sent.record.revision).toBe(1);

    // The person keeps typing while the request is in flight.
    const duringSave = expectStatus(
      await expectOk(
        cache.writeDraft(CONTEXT, "2026-07-03", {
          day: day("2026-07-03", { clockIn: 8, notes: "still editing" }),
          baseline: day("2026-07-03"),
        }),
      ),
      "written",
    );
    expect(duringSave.record.revision).toBe(2);

    const commit = await expectOk(
      cache.commitSave(CONTEXT, {
        date: "2026-07-03",
        confirmedDay: day("2026-07-03", { clockIn: 8 }),
        sentRevision: 1,
        checkedAt: CHECKED_AT,
      }),
    );

    expect(commit.draftCleared).toBe(false);
    expect(commit.pendingRevision).toBe(2);

    const pending = await expectOk(cache.readDraft(CONTEXT, "2026-07-03"));
    expect(pending?.revision).toBe(2);
    expect(pending?.day.notes).toBe("still editing");

    const second = await expectOk(
      cache.commitSave(CONTEXT, {
        date: "2026-07-03",
        confirmedDay: day("2026-07-03", { clockIn: 8, notes: "still editing" }),
        sentRevision: 2,
        checkedAt: CHECKED_AT,
      }),
    );

    expect(second.draftCleared).toBe(true);
    expect(second.pendingRevision).toBe(null);
    expect(await cache.readDraft(CONTEXT, "2026-07-03")).toEqual({ ok: true, value: null });
  });

  it("reports a failed post-save transaction as a typed failure, not as a synced state", async () => {
    expect(
      await rejectingCache().commitSave(CONTEXT, {
        date: "2026-07-03",
        confirmedDay: day("2026-07-03", { clockIn: 8 }),
        sentRevision: 1,
        checkedAt: CHECKED_AT,
      }),
    ).toMatchObject({ ok: false, reason: "quota" });
  });
});

/* -------------------------------------------------------------------------- */
/* Race 3 — an independent remote change on a different date                   */
/* -------------------------------------------------------------------------- */

describe("a clean remote change on another date leaves this date's draft alone", () => {
  it("reports the changed date, conflicts with nothing, and still restores the untouched draft", async () => {
    const cache = freshCache();
    await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT });

    await cache.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const outcome = expectStatus(
      await expectOk(
        cache.writeMonth(CONTEXT, {
          view: view([day("2026-07-03"), day("2026-07-10", { clockIn: 9 })]),
          checkedAt: CHECKED_AT,
          expectedRevision: 1,
        }),
      ),
      "written",
    );

    expect(outcome.changedDates).toEqual(["2026-07-10"]);
    expect(outcome.conflictedDates).toEqual([]);

    const restored = await expectOk(cache.restoreDraft(CONTEXT, "2026-07-03", day("2026-07-03")));
    expectStatus(restored, "restored");
  });

  it("marks the drafted date as conflicted when the remote row behind it moved", async () => {
    const cache = freshCache();
    await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT });
    await cache.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const outcome = expectStatus(
      await expectOk(
        cache.writeMonth(CONTEXT, {
          view: view([day("2026-07-03", { notes: "manager edited" }), day("2026-07-10")]),
          checkedAt: CHECKED_AT,
          expectedRevision: 1,
        }),
      ),
      "written",
    );

    expect(outcome.changedDates).toEqual(["2026-07-03"]);
    expect(outcome.conflictedDates).toEqual(["2026-07-03"]);

    // The draft is still there; only an explicit restore decides its fate.
    expect(await expectOk(cache.readDraft(CONTEXT, "2026-07-03"))).not.toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Race 4 — two tabs writing the same draft key                                */
/* -------------------------------------------------------------------------- */

describe("two tabs editing the same account, file, sheet, and date", () => {
  function twoTabs(): { tabA: AttendanceCache; tabB: AttendanceCache; seen: number[]; data: MemoryData } {
    const data = createMemoryData();
    const hub = createMemoryBroadcastHub();
    const seen: number[] = [];

    const tabA = createAttendanceCache({
      engine: createMemoryEngine({ data }),
      broadcast: hub.connect(),
      now: () => CHECKED_AT,
    });
    const tabB = createAttendanceCache({
      engine: createMemoryEngine({ data }),
      broadcast: hub.connect(),
      now: () => CHECKED_AT,
    });

    tabB.onRevisionChanged((message) => seen.push(message.revision));

    return { tabA, tabB, seen, data };
  }

  it("refuses the stale tab's write and hands it the newer draft instead of overwriting it", async () => {
    const { tabA, tabB } = twoTabs();

    await tabA.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const stale = expectStatus(
      await expectOk(
        tabB.writeDraft(CONTEXT, "2026-07-03", {
          day: day("2026-07-03", { clockIn: 10 }),
          baseline: day("2026-07-03"),
          expectedRevision: 0,
        }),
      ),
      "superseded",
    );

    expect(stale.reason).toBe("revision-advanced");
    expect(stale.current?.revision).toBe(1);

    const stored = await expectOk(tabA.readDraft(CONTEXT, "2026-07-03"));
    expect(stored?.day.clockIn).toBe(8);
  });

  it("refuses a stale tab's clear so a newer local draft is never silently discarded", async () => {
    const { tabA, tabB } = twoTabs();

    await tabA.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const cleared = expectStatus(
      await expectOk(tabB.clearDraft(CONTEXT, "2026-07-03", { expectedRevision: 0 })),
      "superseded",
    );

    expect(cleared.reason).toBe("revision-advanced");
    expect(await expectOk(tabA.readDraft(CONTEXT, "2026-07-03"))).not.toBe(null);
  });

  it("broadcasts the new revision to the other tab", async () => {
    const { tabA, seen } = twoTabs();

    await tabA.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    expect(seen).toEqual([1]);
  });

  it("lets the later tab win once it has re-read the current revision", async () => {
    const { tabA, tabB } = twoTabs();

    await tabA.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const current = await expectOk(tabB.readDraft(CONTEXT, "2026-07-03"));

    const applied = expectStatus(
      await expectOk(
        tabB.writeDraft(CONTEXT, "2026-07-03", {
          day: day("2026-07-03", { clockIn: 10 }),
          baseline: day("2026-07-03"),
          expectedRevision: current?.revision ?? 0,
        }),
      ),
      "written",
    );

    expect(applied.record.revision).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Stale drafts, retention, migration                                          */
/* -------------------------------------------------------------------------- */

describe("a stored draft is restored only onto an identical baseline", () => {
  it("restores when the row is byte-for-byte the same", async () => {
    const cache = freshCache();
    await cache.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const outcome = expectStatus(
      await expectOk(cache.restoreDraft(CONTEXT, "2026-07-03", day("2026-07-03"))),
      "restored",
    );

    expect(outcome.record.day.clockIn).toBe(8);
  });

  it("discards, rather than replays, a draft whose sheet row moved on", async () => {
    const cache = freshCache();
    await cache.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const outcome = expectStatus(
      await expectOk(cache.restoreDraft(CONTEXT, "2026-07-03", day("2026-07-03", { notes: "manager edited" }))),
      "discarded",
    );

    expect(outcome.reason).toBe("baseline-changed");
    expect(await cache.readDraft(CONTEXT, "2026-07-03")).toEqual({ ok: true, value: null });
  });

  it("says so plainly when there is nothing to restore", async () => {
    expectStatus(await expectOk(freshCache().restoreDraft(CONTEXT, "2026-07-03", day("2026-07-03"))), "absent");
  });
});

describe("retention", () => {
  it("keeps a draft with no application TTL, however old it is", async () => {
    const data = createMemoryData();
    const old = createAttendanceCache({
      engine: createMemoryEngine({ data }),
      now: () => "2020-01-01T00:00:00.000Z",
    });

    await old.writeDraft(CONTEXT, "2026-07-03", {
      day: day("2026-07-03", { clockIn: 8 }),
      baseline: day("2026-07-03"),
    });

    const later = createAttendanceCache({ engine: createMemoryEngine({ data }), now: () => CHECKED_AT });

    expect((await expectOk(later.readDraft(CONTEXT, "2026-07-03")))?.updatedAt).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });
});

describe("schema migration", () => {
  it("replaces a clean month cache written under an older schema version", async () => {
    const data = createMemoryData();
    const engine = createMemoryEngine({ data });
    const legacyKey = monthCacheKey(CONTEXT, CACHE_SCHEMA_VERSION - 1);

    await engine.transact([CACHE_MONTH_STORE], "readwrite", (tx) =>
      tx.put(CACHE_MONTH_STORE, legacyKey, { schemaVersion: CACHE_SCHEMA_VERSION - 1 }),
    );

    const outcome = await expectOk(cacheWith(engine).migrate(CONTEXT));

    expect(outcome.action).toBe("replace-clean");
    expect(outcome.removedKeys).toEqual([legacyKey]);
    expect(data.stores[CACHE_MONTH_STORE].has(legacyKey)).toBe(false);
  });

  it("refuses the migration and preserves a pending draft it cannot carry across", async () => {
    const data = createMemoryData();
    const engine = createMemoryEngine({ data });
    const legacyMonth = monthCacheKey(CONTEXT, CACHE_SCHEMA_VERSION - 1);
    const legacyDraft = draftCacheKey(CONTEXT, "2026-07-03", CACHE_SCHEMA_VERSION - 1);

    await engine.transact([CACHE_MONTH_STORE, CACHE_DRAFT_STORE], "readwrite", async (tx) => {
      await tx.put(CACHE_MONTH_STORE, legacyMonth, { schemaVersion: CACHE_SCHEMA_VERSION - 1 });
      await tx.put(CACHE_DRAFT_STORE, legacyDraft, { schemaVersion: CACHE_SCHEMA_VERSION - 1 });
    });

    expect(await cacheWith(engine).migrate(CONTEXT)).toMatchObject({
      ok: false,
      reason: "migration-refused",
    });

    expect(data.stores[CACHE_DRAFT_STORE].has(legacyDraft)).toBe(true);
    expect(data.stores[CACHE_MONTH_STORE].has(legacyMonth)).toBe(true);
  });

  it("does nothing when only current-version records exist", async () => {
    const cache = freshCache();
    await cache.writeMonth(CONTEXT, { view: view(REMOTE_DAYS), checkedAt: CHECKED_AT });

    expect((await expectOk(cache.migrate(CONTEXT))).action).toBe("none");
  });
});
