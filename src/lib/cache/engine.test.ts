import { describe, expect, it } from "vitest";
import { classifyStorageError } from "./results";
import {
  CACHE_DRAFT_STORE,
  CACHE_MONTH_STORE,
  CacheStorageError,
  createMemoryData,
  createMemoryEngine,
  resolveCacheEngine,
} from "./engine";

describe("memory engine", () => {
  it("round-trips a value and lists its keys", async () => {
    const engine = createMemoryEngine();

    await engine.transact([CACHE_MONTH_STORE], "readwrite", async (tx) => {
      await tx.put(CACHE_MONTH_STORE, "k", { a: 1 });
    });

    const value = await engine.transact([CACHE_MONTH_STORE], "readonly", (tx) =>
      tx.get(CACHE_MONTH_STORE, "k"),
    );
    const keys = await engine.transact([CACHE_MONTH_STORE], "readonly", (tx) =>
      tx.keys(CACHE_MONTH_STORE),
    );

    expect(value).toEqual({ a: 1 });
    expect(keys).toEqual(["k"]);
  });

  it("rolls the whole transaction back when the body throws", async () => {
    const engine = createMemoryEngine();

    await engine.transact([CACHE_MONTH_STORE], "readwrite", async (tx) => {
      await tx.put(CACHE_MONTH_STORE, "k", "before");
    });

    await expect(
      engine.transact([CACHE_MONTH_STORE, CACHE_DRAFT_STORE], "readwrite", async (tx) => {
        await tx.put(CACHE_MONTH_STORE, "k", "after");
        await tx.put(CACHE_DRAFT_STORE, "d", "after");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const month = await engine.transact([CACHE_MONTH_STORE], "readonly", (tx) =>
      tx.get(CACHE_MONTH_STORE, "k"),
    );
    const draft = await engine.transact([CACHE_DRAFT_STORE], "readonly", (tx) =>
      tx.get(CACHE_DRAFT_STORE, "d"),
    );

    expect(month).toBe("before");
    expect(draft).toBe(undefined);
  });

  it("serializes transactions so a read-modify-write cannot interleave", async () => {
    const engine = createMemoryEngine();

    const bump = () =>
      engine.transact([CACHE_MONTH_STORE], "readwrite", async (tx) => {
        const current = (await tx.get(CACHE_MONTH_STORE, "n")) as number | undefined;
        await Promise.resolve();
        await tx.put(CACHE_MONTH_STORE, "n", (current ?? 0) + 1);
      });

    await Promise.all([bump(), bump(), bump()]);

    const total = await engine.transact([CACHE_MONTH_STORE], "readonly", (tx) =>
      tx.get(CACHE_MONTH_STORE, "n"),
    );

    expect(total).toBe(3);
  });

  it("lets two engines share one dataset, the way two browser tabs do", async () => {
    const data = createMemoryData();
    const tabA = createMemoryEngine({ data });
    const tabB = createMemoryEngine({ data });

    await tabA.transact([CACHE_DRAFT_STORE], "readwrite", (tx) => tx.put(CACHE_DRAFT_STORE, "d", 1));

    expect(
      await tabB.transact([CACHE_DRAFT_STORE], "readonly", (tx) => tx.get(CACHE_DRAFT_STORE, "d")),
    ).toBe(1);
  });

  it("rejects with a typed storage error when the browser refuses the write", async () => {
    const engine = createMemoryEngine({
      fail: ({ mode }) => (mode === "readwrite" ? new CacheStorageError("quota", "disk full") : null),
    });

    await expect(
      engine.transact([CACHE_DRAFT_STORE], "readwrite", (tx) => tx.put(CACHE_DRAFT_STORE, "d", 1)),
    ).rejects.toBeInstanceOf(CacheStorageError);
  });
});

describe("classifyStorageError", () => {
  it("passes a typed storage error through unchanged", () => {
    expect(classifyStorageError(new CacheStorageError("blocked", "another tab holds it"))).toEqual({
      ok: false,
      reason: "blocked",
      message: "another tab holds it",
    });
  });

  it("maps the browser's own exception names to reasons", () => {
    const named = (name: string) => classifyStorageError(Object.assign(new Error(name), { name })).reason;

    expect(named("QuotaExceededError")).toBe("quota");
    expect(named("NS_ERROR_DOM_QUOTA_REACHED")).toBe("quota");
    expect(named("DataCloneError")).toBe("corrupt");
    expect(named("DataError")).toBe("corrupt");
    expect(named("SecurityError")).toBe("unavailable");
    expect(named("InvalidStateError")).toBe("unavailable");
    expect(named("VersionError")).toBe("blocked");
  });

  it("falls back to unavailable for anything it does not recognize", () => {
    expect(classifyStorageError(new Error("who knows")).reason).toBe("unavailable");
    expect(classifyStorageError("not even an error").reason).toBe("unavailable");
  });
});

describe("resolveCacheEngine", () => {
  it("returns null rather than a pretend engine when the browser has no IndexedDB", () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(resolveCacheEngine()).toBe(null);
  });
});
