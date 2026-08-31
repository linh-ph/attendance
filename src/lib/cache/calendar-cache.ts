/**
 * Acknowledged storage for the calendar's quick-info records.
 *
 * Two records live here, in one store and one transaction:
 *
 * - a **snapshot** per (account, file, sheet, month) — the per-date states the
 *   month grid paints from;
 * - a **pointer** per account — the month the calendar was last showing, so a
 *   reload restores the same context before discovery has answered anything.
 *
 * They are written together, atomically, so the pointer can never name a month
 * whose snapshot failed to store. That is the whole reason this is a
 * transactional engine call rather than two `put`s.
 *
 * Like `attendance-cache.ts`, **every** method resolves to a `CacheResult`.
 * There is no silent no-op: a browser with storage disabled produces an
 * explicit `unavailable`, and the calendar says so rather than implying the
 * month was cached. Nothing stored here is authoritative — the server re-reads
 * the sheet and re-authorizes on every request.
 */

import {
  isCalendarPointer,
  isCalendarSnapshot,
  pointerForSnapshot,
  type CalendarPointer,
  type CalendarSnapshot,
} from "./calendar-state";
import {
  CALENDAR_STORE,
  CacheStorageError,
  resolveCacheEngine,
  type CacheEngine,
  type CacheTransaction,
  type TransactionMode,
} from "./engine";
import { CACHE_SCHEMA_VERSION, findCredentialMaterial, normalizeAccount } from "./keys";
import { classifyStorageError, fail, ok, type CacheResult } from "./results";

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

const KEY_SEPARATOR = "::";
const SNAPSHOT_PREFIX = "cal";
const POINTER_PREFIX = "ptr";

export interface CalendarCacheContext {
  email: string;
  fileId: string;
  sheetId: string;
  /** `YYYY-MM`. */
  month: string;
}

export function calendarSnapshotKey(
  context: CalendarCacheContext,
  schemaVersion = CACHE_SCHEMA_VERSION,
): string {
  return [
    SNAPSHOT_PREFIX,
    `v${schemaVersion}`,
    normalizeAccount(context.email),
    context.fileId,
    context.sheetId,
    context.month,
  ].join(KEY_SEPARATOR);
}

export function calendarPointerKey(email: string, schemaVersion = CACHE_SCHEMA_VERSION): string {
  return [POINTER_PREFIX, `v${schemaVersion}`, normalizeAccount(email)].join(KEY_SEPARATOR);
}

/** The account a calendar key belongs to, or `null` when it is not one. */
function accountOfKey(key: string): string | null {
  const parts = key.split(KEY_SEPARATOR);
  if (parts.length < 3) return null;

  const [prefix, version, account] = parts;
  if (prefix !== SNAPSHOT_PREFIX && prefix !== POINTER_PREFIX) return null;
  if (!version.startsWith("v") || !account) return null;

  return account;
}

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

export interface SnapshotWriteOutcome {
  status: "written";
}

export interface ClearAccountOutcome {
  removed: number;
}

export interface CalendarCache {
  /** Which month this account's calendar was last on. `null` when unknown. */
  readPointer(email: string): Promise<CacheResult<CalendarPointer | null>>;
  readSnapshot(context: CalendarCacheContext): Promise<CacheResult<CalendarSnapshot | null>>;
  /** Stores the snapshot and moves the pointer onto it, atomically. */
  writeSnapshot(snapshot: CalendarSnapshot): Promise<CacheResult<SnapshotWriteOutcome>>;
  /** Removes one account's calendar records. Another account's are untouched. */
  clearAccount(email: string): Promise<CacheResult<ClearAccountOutcome>>;
  close(): void;
}

export interface CalendarCacheOptions {
  /** `null` models a browser with no usable IndexedDB. */
  engine: CacheEngine | null;
  now?: () => string;
  schemaVersion?: number;
}

const NO_STORAGE = "This browser has no usable local storage.";

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

function refuseCredentials(value: unknown): CacheResult<never> | null {
  const found = findCredentialMaterial(value);
  if (found === null) return null;

  return fail(
    "forbidden-content",
    `Refused to store credential-shaped material at "${found}". Tokens, cookies, and authorization results never enter IndexedDB.`,
  );
}

export function createCalendarCache(options: CalendarCacheOptions): CalendarCache {
  const { engine } = options;
  const schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const now = options.now ?? (() => new Date().toISOString());

  const unavailable = <T>(): CacheResult<T> => fail("unavailable", NO_STORAGE);

  async function run<T>(
    mode: TransactionMode,
    body: (tx: CacheTransaction) => Promise<T>,
  ): Promise<CacheResult<T>> {
    if (engine === null) return unavailable<T>();

    try {
      return ok(await engine.transact([CALENDAR_STORE], mode, body));
    } catch (error) {
      return classifyStorageError(error);
    }
  }

  return {
    close() {
      engine?.close();
    },

    readPointer(email) {
      return run("readonly", async (tx) => {
        const raw = await tx.get(CALENDAR_STORE, calendarPointerKey(email, schemaVersion));
        if (raw === undefined) return null;

        if (!isCalendarPointer(raw)) {
          // Left in place deliberately: a record this build cannot read is not
          // proof it is rubbish, and deleting it would lose another build's.
          throw new CacheStorageError(
            "corrupt",
            "The stored calendar position could not be read and was left in place.",
          );
        }

        return raw;
      });
    },

    readSnapshot(context) {
      return run("readonly", async (tx) => {
        const raw = await tx.get(CALENDAR_STORE, calendarSnapshotKey(context, schemaVersion));
        if (raw === undefined) return null;

        if (!isCalendarSnapshot(raw)) {
          throw new CacheStorageError(
            "corrupt",
            "The cached calendar could not be read and was left in place.",
          );
        }

        return raw;
      });
    },

    async writeSnapshot(snapshot) {
      // Runs before the transaction opens, so a refused value never reaches
      // storage even momentarily.
      const refused = refuseCredentials(snapshot);
      if (refused) return refused;

      const context: CalendarCacheContext = {
        email: snapshot.account,
        fileId: snapshot.fileId,
        sheetId: snapshot.sheetId,
        month: snapshot.month,
      };

      return run("readwrite", async (tx) => {
        await tx.put(CALENDAR_STORE, calendarSnapshotKey(context, schemaVersion), snapshot);
        await tx.put(
          CALENDAR_STORE,
          calendarPointerKey(snapshot.account, schemaVersion),
          pointerForSnapshot(snapshot, now()),
        );

        return { status: "written" as const };
      });
    },

    clearAccount(email) {
      const account = normalizeAccount(email);

      return run("readwrite", async (tx) => {
        const keys = await tx.keys(CALENDAR_STORE);
        let removed = 0;

        for (const key of keys) {
          if (accountOfKey(key) !== account) continue;
          await tx.delete(CALENDAR_STORE, key);
          removed += 1;
        }

        return { removed };
      });
    },
  };
}

/**
 * The cache the browser actually gets. `resolveCacheEngine` answers `null`
 * where IndexedDB does not exist, and every call then reports `unavailable`
 * rather than pretending to have cached anything.
 */
export function resolveCalendarCache(): CalendarCache {
  return createCalendarCache({ engine: resolveCacheEngine() });
}
