/**
 * Browser-local attendance store — **the compatibility surface.**
 *
 * The authoritative browser cache is now `@/lib/cache/attendance-cache`, which
 * acknowledges every operation with an explicit success or a typed failure, and
 * closes the revalidation/Save/multi-tab races in spec §5.5. This module stays
 * because six screens still call the older shape, and this task does not own
 * those files: it keeps them compiling and behaving exactly as before while
 * they migrate to `AttendanceCache` one surface at a time.
 *
 * It holds three convenience records, all scoped to the normalized signed-in
 * email (see `local-records.ts`):
 *
 * - unsaved day drafts, so work survives a reload or a dropped connection;
 * - the last loaded month per sheet, so reopening renders before the network;
 * - recently opened sheets, so the paste-a-link shortcut has a history;
 * - the browser-local roster, so a file can be created without retyping people.
 *
 * None of it is authoritative. The server re-reads the sheet and re-authorizes
 * every request, so a tampered record can at worst show a stale month to the
 * person who tampered with it. Tokens and authorization results are never
 * stored — `findCredentialMaterial` refuses the write outright.
 *
 * **Two layers, deliberately.** `AcknowledgedLocalStore` is the real one: it
 * returns `CacheResult`, so a rejected write is a typed failure and never a
 * false `Saved locally`. `LocalStore` is the legacy shape, and `toLegacyStore`
 * is the single, named place where that failure is turned back into the old
 * fallback value. New code must not use `LocalStore`.
 */

import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import {
  DRAFT_STORE,
  MEMBER_STORE,
  MONTH_STORE,
  RECENT_STORE,
  createIndexedDbEngine,
  createMemoryEngine,
  resolveCacheEngine,
  type CacheEngine,
  type CacheTransaction,
  type TransactionMode,
} from "@/lib/cache/engine";
import { findCredentialMaterial } from "@/lib/cache/keys";
import { classifyStorageError, fail, ok, type CacheResult } from "@/lib/cache/results";
import {
  addRecentFile,
  addStoredMember,
  draftKey,
  isDraftRecord,
  isMonthCacheRecord,
  isRecentFile,
  isStoredMember,
  memberKey,
  monthCacheKey,
  recentKey,
  removeStoredMember,
  scopeKey,
  type RecentFile,
  type StoredMember,
} from "./local-records";

export {
  DB_NAME,
  DB_VERSION,
  DRAFT_STORE,
  MEMBER_STORE,
  MONTH_STORE,
  RECENT_STORE,
} from "@/lib/cache/engine";

export interface StoredDraft {
  day: AttendanceDay;
  baseline: AttendanceDay;
}

/** @deprecated Use `AttendanceCache`; failures are invisible through here. */
export interface LocalStore {
  readDraft(
    email: string,
    fileId: string,
    sheetId: string,
    date: string,
  ): Promise<StoredDraft | null>;
  writeDraft(
    email: string,
    fileId: string,
    sheetId: string,
    date: string,
    draft: StoredDraft,
  ): Promise<void>;
  clearDraft(email: string, fileId: string, sheetId: string, date: string): Promise<void>;
  readMonth(email: string, fileId: string, sheetId: string): Promise<AttendanceMonthView | null>;
  writeMonth(
    email: string,
    fileId: string,
    sheetId: string,
    view: AttendanceMonthView,
  ): Promise<void>;
  readRecent(email: string): Promise<RecentFile[]>;
  addRecent(email: string, entry: RecentFile): Promise<RecentFile[]>;
  readMembers(email: string): Promise<StoredMember[]>;
  addMember(email: string, member: StoredMember): Promise<StoredMember[]>;
  removeMember(email: string, memberEmail: string): Promise<StoredMember[]>;
}

/** The same operations, each answering with an acknowledged result. */
export interface AcknowledgedLocalStore {
  readDraft(
    email: string,
    fileId: string,
    sheetId: string,
    date: string,
  ): Promise<CacheResult<StoredDraft | null>>;
  writeDraft(
    email: string,
    fileId: string,
    sheetId: string,
    date: string,
    draft: StoredDraft,
  ): Promise<CacheResult<void>>;
  clearDraft(
    email: string,
    fileId: string,
    sheetId: string,
    date: string,
  ): Promise<CacheResult<void>>;
  readMonth(
    email: string,
    fileId: string,
    sheetId: string,
  ): Promise<CacheResult<AttendanceMonthView | null>>;
  writeMonth(
    email: string,
    fileId: string,
    sheetId: string,
    view: AttendanceMonthView,
  ): Promise<CacheResult<void>>;
  readRecent(email: string): Promise<CacheResult<RecentFile[]>>;
  addRecent(email: string, entry: RecentFile): Promise<CacheResult<RecentFile[]>>;
  readMembers(email: string): Promise<CacheResult<StoredMember[]>>;
  addMember(email: string, member: StoredMember): Promise<CacheResult<StoredMember[]>>;
  removeMember(email: string, memberEmail: string): Promise<CacheResult<StoredMember[]>>;
}

/* -------------------------------------------------------------------------- */
/* Acknowledged implementation                                                 */
/* -------------------------------------------------------------------------- */

function refuseCredentials(value: unknown): CacheResult<never> | null {
  const found = findCredentialMaterial(value);
  if (found === null) return null;

  return fail(
    "forbidden-content",
    `Refused to store credential-shaped material at "${found}". Tokens, cookies, and secrets never enter IndexedDB.`,
  );
}

export function createAcknowledgedStore(engine: CacheEngine): AcknowledgedLocalStore {
  async function run<T>(
    stores: readonly string[],
    mode: TransactionMode,
    body: (tx: CacheTransaction) => Promise<T>,
  ): Promise<CacheResult<T>> {
    try {
      return ok(await engine.transact(stores, mode, body));
    } catch (error) {
      return classifyStorageError(error);
    }
  }

  async function readList<T>(
    tx: CacheTransaction,
    store: string,
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T[]> {
    const stored = await tx.get(store, key);
    return Array.isArray(stored) ? stored.filter(guard) : [];
  }

  return {
    readDraft(email, fileId, sheetId, date) {
      return run([DRAFT_STORE], "readonly", async (tx) => {
        const stored = await tx.get(DRAFT_STORE, draftKey(email, fileId, sheetId, date));
        return isDraftRecord(stored) ? { day: stored.day, baseline: stored.baseline } : null;
      });
    },

    writeDraft(email, fileId, sheetId, date, draft) {
      const refused = refuseCredentials(draft);
      if (refused) return Promise.resolve(refused);

      return run([DRAFT_STORE], "readwrite", (tx) =>
        tx.put(
          DRAFT_STORE,
          draftKey(email, fileId, sheetId, date),
          { email: scopeKey(email), day: draft.day, baseline: draft.baseline },
        ),
      );
    },

    clearDraft(email, fileId, sheetId, date) {
      return run([DRAFT_STORE], "readwrite", (tx) =>
        tx.delete(DRAFT_STORE, draftKey(email, fileId, sheetId, date)),
      );
    },

    readMonth(email, fileId, sheetId) {
      return run([MONTH_STORE], "readonly", async (tx) => {
        const stored = await tx.get(MONTH_STORE, monthCacheKey(email, fileId, sheetId));
        return isMonthCacheRecord(stored) ? stored.view : null;
      });
    },

    writeMonth(email, fileId, sheetId, view) {
      const refused = refuseCredentials(view);
      if (refused) return Promise.resolve(refused);

      return run([MONTH_STORE], "readwrite", (tx) =>
        tx.put(MONTH_STORE, monthCacheKey(email, fileId, sheetId), {
          email: scopeKey(email),
          view,
        }),
      );
    },

    readRecent(email) {
      return run([RECENT_STORE], "readonly", (tx) =>
        readList(tx, RECENT_STORE, recentKey(email), isRecentFile),
      );
    },

    addRecent(email, entry) {
      const refused = refuseCredentials(entry);
      if (refused) return Promise.resolve(refused);

      return run([RECENT_STORE], "readwrite", async (tx) => {
        const next = addRecentFile(await readList(tx, RECENT_STORE, recentKey(email), isRecentFile), entry);
        await tx.put(RECENT_STORE, recentKey(email), next);
        return next;
      });
    },

    readMembers(email) {
      return run([MEMBER_STORE], "readonly", (tx) =>
        readList(tx, MEMBER_STORE, memberKey(email), isStoredMember),
      );
    },

    addMember(email, member) {
      const refused = refuseCredentials(member);
      if (refused) return Promise.resolve(refused);

      return run([MEMBER_STORE], "readwrite", async (tx) => {
        const next = addStoredMember(
          await readList(tx, MEMBER_STORE, memberKey(email), isStoredMember),
          member,
        );
        await tx.put(MEMBER_STORE, memberKey(email), next);
        return next;
      });
    },

    removeMember(email, memberEmail) {
      return run([MEMBER_STORE], "readwrite", async (tx) => {
        const next = removeStoredMember(
          await readList(tx, MEMBER_STORE, memberKey(email), isStoredMember),
          memberEmail,
        );
        await tx.put(MEMBER_STORE, memberKey(email), next);
        return next;
      });
    },
  };
}

/** A store that refuses everything, for a browser with no IndexedDB at all. */
export function createUnavailableStore(message: string): AcknowledgedLocalStore {
  const refusal = async () => fail("unavailable", message);

  return {
    readDraft: refusal,
    writeDraft: refusal,
    clearDraft: refusal,
    readMonth: refusal,
    writeMonth: refusal,
    readRecent: refusal,
    addRecent: refusal,
    readMembers: refusal,
    addMember: refusal,
    removeMember: refusal,
  };
}

/* -------------------------------------------------------------------------- */
/* Legacy adapter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one place a typed failure becomes the old fallback value.
 *
 * Every legacy call site treats storage as best-effort and already ignores
 * rejections, so preserving that is what "keeps behaving" means here. It is
 * also exactly the honesty problem the redesign is fixing, which is why this
 * conversion is named, isolated, and deprecated rather than spread through an
 * adapter that quietly swallows errors in ten places.
 */
function orFallback<T>(result: CacheResult<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** @deprecated Wraps an acknowledged store in the pre-redesign shape. */
export function toLegacyStore(store: AcknowledgedLocalStore): LocalStore {
  return {
    async readDraft(email, fileId, sheetId, date) {
      return orFallback(await store.readDraft(email, fileId, sheetId, date), null);
    },
    async writeDraft(email, fileId, sheetId, date, draft) {
      await store.writeDraft(email, fileId, sheetId, date, draft);
    },
    async clearDraft(email, fileId, sheetId, date) {
      await store.clearDraft(email, fileId, sheetId, date);
    },
    async readMonth(email, fileId, sheetId) {
      return orFallback(await store.readMonth(email, fileId, sheetId), null);
    },
    async writeMonth(email, fileId, sheetId, view) {
      await store.writeMonth(email, fileId, sheetId, view);
    },
    async readRecent(email) {
      return orFallback(await store.readRecent(email), []);
    },
    async addRecent(email, entry) {
      // The optimistic echo the old null store returned, so a caller that
      // renders the result still shows the entry the person just opened.
      return orFallback(await store.addRecent(email, entry), [entry]);
    },
    async readMembers(email) {
      return orFallback(await store.readMembers(email), []);
    },
    async addMember(email, member) {
      return orFallback(await store.addMember(email, member), [member]);
    },
    async removeMember(email, memberEmail) {
      return orFallback(await store.removeMember(email, memberEmail), []);
    },
  };
}

/**
 * The store tests inject. It keeps the same key scoping and the same
 * transactional engine as the IndexedDB adapter, so a test proves real
 * behavior rather than a simplified double.
 */
export function createMemoryStore(): LocalStore {
  return toLegacyStore(createAcknowledgedStore(createMemoryEngine()));
}

/** A store that holds nothing, used when IndexedDB cannot be opened at all. */
export function createNullStore(): LocalStore {
  return toLegacyStore(createUnavailableStore("This browser has no IndexedDB."));
}

export function createIndexedDbStore(factory: IDBFactory): LocalStore {
  return toLegacyStore(createAcknowledgedStore(createIndexedDbEngine(factory)));
}

/** The store the browser uses, or a null store when IndexedDB is absent. */
export function resolveLocalStore(): LocalStore {
  const engine = resolveCacheEngine();
  if (engine === null) return createNullStore();

  return toLegacyStore(createAcknowledgedStore(engine));
}
