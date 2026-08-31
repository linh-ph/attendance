/**
 * The transactional storage engine the attendance cache runs on.
 *
 * This is the only module in `src/lib/cache/` that knows IndexedDB exists.
 * Everything above it works against `CacheEngine`, which offers exactly one
 * primitive: **one transaction, several keys, all or nothing**. The ordering
 * rules in spec §5.5 — clear only the revision that was sent, refuse a
 * revalidation that lost to a Save, refuse a stale tab's write — are all
 * read-compare-write races, and they are only safe if the compare and the write
 * happen inside the same transaction. A `get` followed by a separate `put`
 * would reintroduce every race the spec asks us to close.
 *
 * A failure here is always a typed `CacheStorageError`, never a silent `null`.
 * The old store cached a failed open as "no store" and turned every later call
 * into a no-op; that is precisely what the redesign forbids.
 */

import { CacheStorageError } from "./results";

export { CacheStorageError } from "./results";

export const DB_NAME = "attendance-local";

/**
 * Raised to 4 for the calendar quick-info store. `onupgradeneeded` only runs
 * when this changes; every other store is created there too so a profile that
 * has never opened the app gets all of them at once, and a profile upgrading
 * from 3 gains only the store it is missing — the handler adds what is absent
 * and touches nothing that already exists, so no cached month or pending draft
 * is disturbed by the bump.
 */
export const DB_VERSION = 4;

/** Legacy stores, still read and written by the compatibility adapter. */
export const DRAFT_STORE = "drafts";
export const MONTH_STORE = "months";
export const RECENT_STORE = "recent";
export const MEMBER_STORE = "members";

/** The acknowledged cache's own stores. */
export const CACHE_MONTH_STORE = "cache-months";
export const CACHE_DRAFT_STORE = "cache-drafts";

/**
 * The calendar's quick-info store: which month the calendar is on, and one
 * small state per date. Separate from `cache-months` on purpose — the calendar
 * reads it on its first frame and must not pull a whole month of work slots
 * into memory to draw a grid.
 */
export const CALENDAR_STORE = "calendar";

export const ALL_STORES = [
  DRAFT_STORE,
  MONTH_STORE,
  RECENT_STORE,
  MEMBER_STORE,
  CACHE_MONTH_STORE,
  CACHE_DRAFT_STORE,
  CALENDAR_STORE,
] as const;

export type TransactionMode = "readonly" | "readwrite";

export interface CacheTransaction {
  get(store: string, key: string): Promise<unknown>;
  put(store: string, key: string, value: unknown): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  keys(store: string): Promise<string[]>;
}

export interface CacheEngine {
  /**
   * Runs `body` inside one transaction over `stores`. Resolving commits;
   * throwing rolls back and rejects with a `CacheStorageError`.
   */
  transact<T>(
    stores: readonly string[],
    mode: TransactionMode,
    body: (tx: CacheTransaction) => Promise<T> | T,
  ): Promise<T>;
  close(): void;
}

/** IndexedDB stores a structured clone, so an engine must too. */
function clone(value: unknown): unknown {
  if (value === undefined) return undefined;

  try {
    return structuredClone(value);
  } catch (error) {
    throw new CacheStorageError(
      "corrupt",
      error instanceof Error ? error.message : "The value could not be stored.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Memory engine                                                               */
/* -------------------------------------------------------------------------- */

export interface MemoryData {
  stores: Record<string, Map<string, unknown>>;
  /** Serializes transactions the way one IndexedDB connection does. */
  queue: Promise<unknown>;
}

export function createMemoryData(): MemoryData {
  const stores: Record<string, Map<string, unknown>> = {};
  for (const name of ALL_STORES) stores[name] = new Map();

  return { stores, queue: Promise.resolve() };
}

export interface MemoryEngineOptions {
  /** Share one dataset between engines to model two browser tabs. */
  data?: MemoryData;
  /** Return an error to make the browser refuse this transaction. */
  fail?: (info: { stores: readonly string[]; mode: TransactionMode }) => CacheStorageError | null;
}

/**
 * The deterministic engine the tests run on.
 *
 * It is not a convenience double: it enforces the same guarantees the real one
 * does — serialized transactions, all-or-nothing commit, stored clones — so a
 * race proven here is a race actually closed.
 */
export function createMemoryEngine(options: MemoryEngineOptions = {}): CacheEngine {
  const data = options.data ?? createMemoryData();

  return {
    close() {},

    transact(stores, mode, body) {
      const run = async () => {
        const refused = options.fail?.({ stores, mode }) ?? null;
        if (refused) throw refused;

        for (const name of stores) {
          data.stores[name] ??= new Map();
        }

        // Snapshot every touched store so a throw rolls the whole thing back.
        const snapshot = new Map(stores.map((name) => [name, new Map(data.stores[name])]));

        const tx: CacheTransaction = {
          async get(store, key) {
            assertScope(stores, store);
            return clone(data.stores[store].get(key));
          },
          async put(store, key, value) {
            assertScope(stores, store);
            assertWritable(mode);
            data.stores[store].set(key, clone(value));
          },
          async delete(store, key) {
            assertScope(stores, store);
            assertWritable(mode);
            data.stores[store].delete(key);
          },
          async keys(store) {
            assertScope(stores, store);
            return [...data.stores[store].keys()];
          },
        };

        try {
          return await body(tx);
        } catch (error) {
          for (const [name, entries] of snapshot) data.stores[name] = entries;
          throw error;
        }
      };

      // Chain onto the queue so no two transactions interleave, and so one
      // failure never poisons the next.
      const result = data.queue.then(run, run);
      data.queue = result.then(
        () => undefined,
        () => undefined,
      );

      return result;
    },
  };
}

function assertScope(stores: readonly string[], store: string): void {
  if (!stores.includes(store)) {
    throw new CacheStorageError("corrupt", `Store ${store} is outside this transaction.`);
  }
}

function assertWritable(mode: TransactionMode): void {
  if (mode !== "readwrite") {
    throw new CacheStorageError("corrupt", "This transaction is read-only.");
  }
}

/* -------------------------------------------------------------------------- */
/* IndexedDB engine                                                            */
/* -------------------------------------------------------------------------- */

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The request failed."));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;

    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB refused to open."));
    request.onblocked = () =>
      reject(new CacheStorageError("blocked", "Another tab is holding an older version open."));
  });
}

export function createIndexedDbEngine(factory: IDBFactory): CacheEngine {
  let pending: Promise<IDBDatabase> | null = null;
  let opened: IDBDatabase | null = null;

  /**
   * Opened lazily and shared. A rejection is **not** memoized as "no storage":
   * a blocked upgrade clears when the other tab closes, so the next call tries
   * again and reports honestly either way.
   */
  function connect(): Promise<IDBDatabase> {
    pending ??= openDatabase(factory).then(
      (db) => {
        opened = db;
        return db;
      },
      (error) => {
        pending = null;
        throw error;
      },
    );

    return pending;
  }

  return {
    close() {
      opened?.close();
      opened = null;
      pending = null;
    },

    async transact(stores, mode, body) {
      const db = await connect();
      const transaction = db.transaction([...stores], mode);

      const settled = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new CacheStorageError("unavailable", "The transaction aborted."));
        transaction.onerror = () =>
          reject(transaction.error ?? new CacheStorageError("unavailable", "The transaction failed."));
      });

      const tx: CacheTransaction = {
        get: (store, key) => requestToPromise(transaction.objectStore(store).get(key)),
        put: async (store, key, value) => {
          await requestToPromise(transaction.objectStore(store).put(value, key));
        },
        delete: async (store, key) => {
          await requestToPromise(transaction.objectStore(store).delete(key));
        },
        keys: async (store) => {
          const keys = await requestToPromise(transaction.objectStore(store).getAllKeys());
          return keys.map(String);
        },
      };

      try {
        const value = await body(tx);
        // Wait for the commit itself: a `put` that resolved can still be
        // undone by a quota failure at commit time.
        if (mode === "readwrite") await settled;
        return value;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already finished; the rejection below is what matters.
        }
        throw error;
      }
    },
  };
}

/**
 * The engine this browser can use, or `null` when there is no IndexedDB at all.
 *
 * `null` is deliberately not an empty engine. The caller turns it into an
 * acknowledged `unavailable` failure on every call, so nothing can mistake
 * "there is no storage" for "the write succeeded".
 */
export function resolveCacheEngine(): CacheEngine | null {
  if (typeof indexedDB === "undefined" || indexedDB === null) return null;
  return createIndexedDbEngine(indexedDB);
}
