/**
 * One record per account: the file, tab, and month the calendar was last on.
 *
 * The month data itself lives in `attendance-cache` and is not duplicated here
 * — this is only the *address* of it. That address is what the calendar cannot
 * otherwise reconstruct on a cold open: `attendance-cache` is keyed by
 * (account, file, sheet, month), so without knowing the file there is no key to
 * read, and a browser that already holds the month would still draw nothing
 * until discovery answered. With the pointer, a reload or an offline open finds
 * the cached month immediately and Google is consulted afterwards.
 *
 * It is a convenience, never an authority. It holds no role and no token, the
 * credential guard refuses the write if either ever appears, and the server
 * re-reads the sheet and re-authorizes every request regardless of what is
 * stored here.
 *
 * Like the rest of `cache/`, every method resolves to a `CacheResult`: a
 * refusal is reported, never swallowed.
 */

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

const KEY_SEPARATOR = "::";
const POINTER_PREFIX = "ptr";

export interface CalendarPointer {
  schemaVersion: number;
  /** Normalized signed-in email. Scopes the record; grants nothing. */
  account: string;
  fileId: string;
  /** Numeric sheet ID as a string, matching the rest of the app. */
  sheetId: string;
  /** `YYYY-MM`. */
  month: string;
  updatedAt: string;
}

export function calendarPointerKey(email: string, schemaVersion = CACHE_SCHEMA_VERSION): string {
  return [POINTER_PREFIX, `v${schemaVersion}`, normalizeAccount(email)].join(KEY_SEPARATOR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function isCalendarPointer(value: unknown): value is CalendarPointer {
  if (!isRecord(value)) return false;

  return (
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    isNonEmptyString(value.account) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.sheetId) &&
    isNonEmptyString(value.month) &&
    isNonEmptyString(value.updatedAt) &&
    // An authorization outcome is not something this build ever wrote.
    value.role === undefined
  );
}

export interface WriteCalendarPointerInput {
  email: string;
  fileId: string;
  sheetId: string;
  month: string;
}

export interface CalendarPointerStore {
  read(email: string): Promise<CacheResult<CalendarPointer | null>>;
  write(input: WriteCalendarPointerInput): Promise<CacheResult<CalendarPointer>>;
  clear(email: string): Promise<CacheResult<void>>;
  close(): void;
}

export interface CalendarPointerStoreOptions {
  /** `null` models a browser with no usable IndexedDB. */
  engine: CacheEngine | null;
  now?: () => string;
  schemaVersion?: number;
}

const NO_STORAGE = "This browser has no usable local storage.";

export function createCalendarPointerStore(
  options: CalendarPointerStoreOptions,
): CalendarPointerStore {
  const { engine } = options;
  const schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const now = options.now ?? (() => new Date().toISOString());

  async function run<T>(
    mode: TransactionMode,
    body: (tx: CacheTransaction) => Promise<T>,
  ): Promise<CacheResult<T>> {
    if (engine === null) return fail("unavailable", NO_STORAGE);

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

    read(email) {
      return run("readonly", async (tx) => {
        const raw = await tx.get(CALENDAR_STORE, calendarPointerKey(email, schemaVersion));
        if (raw === undefined) return null;

        if (!isCalendarPointer(raw)) {
          // Left in place: a record this build cannot read is not proof it is
          // rubbish, and deleting it would lose another build's.
          throw new CacheStorageError(
            "corrupt",
            "The stored calendar position could not be read and was left in place.",
          );
        }

        return raw;
      });
    },

    async write(input) {
      const pointer: CalendarPointer = {
        schemaVersion,
        account: normalizeAccount(input.email),
        fileId: input.fileId,
        sheetId: input.sheetId,
        month: input.month,
        updatedAt: now(),
      };

      const found = findCredentialMaterial(pointer);
      if (found !== null) {
        return fail(
          "forbidden-content",
          `Refused to store credential-shaped material at "${found}".`,
        );
      }

      return run("readwrite", async (tx) => {
        await tx.put(CALENDAR_STORE, calendarPointerKey(input.email, schemaVersion), pointer);
        return pointer;
      });
    },

    clear(email) {
      return run("readwrite", async (tx) => {
        await tx.delete(CALENDAR_STORE, calendarPointerKey(email, schemaVersion));
      });
    },
  };
}

/** The store the browser actually gets; `unavailable` where IndexedDB is not. */
export function resolveCalendarPointerStore(): CalendarPointerStore {
  return createCalendarPointerStore({ engine: resolveCacheEngine() });
}
