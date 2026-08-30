/**
 * Browser-local attendance store.
 *
 * Holds three convenience records, all scoped to the normalized signed-in
 * email (see `local-records.ts`):
 *
 * - unsaved day drafts, so work survives a reload or a dropped connection;
 * - the last loaded month per sheet, so reopening renders before the network;
 * - recently opened sheets, so the paste-a-link shortcut has a history.
 *
 * None of it is authoritative. The server re-reads the sheet and re-authorizes
 * every request, so a tampered record can at worst show a stale month to the
 * person who tampered with it. Tokens and authorization results are never
 * stored.
 *
 * Every operation degrades to a no-op when IndexedDB is unavailable (private
 * mode, disabled storage, or a browser that refuses the upgrade), so the editor
 * works exactly as before when there is no store.
 */

import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
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
  type RecentFile,
  type StoredMember,
} from "./local-records";

export const DB_NAME = "attendance-local";
// Raised for the roster store; `onupgradeneeded` only runs when this changes.
export const DB_VERSION = 2;
export const DRAFT_STORE = "drafts";
export const MONTH_STORE = "months";
export const RECENT_STORE = "recent";
export const MEMBER_STORE = "members";

export interface StoredDraft {
  day: AttendanceDay;
  baseline: AttendanceDay;
}

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

/* -------------------------------------------------------------------------- */
/* In-memory store                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The store the editor falls back to, and the one tests inject. It keeps the
 * same key scoping as the IndexedDB adapter so a test proves real behavior.
 */
export function createMemoryStore(): LocalStore {
  const drafts = new Map<string, StoredDraft>();
  const months = new Map<string, AttendanceMonthView>();
  const recents = new Map<string, RecentFile[]>();
  const members = new Map<string, StoredMember[]>();

  return {
    async readDraft(email, fileId, sheetId, date) {
      return drafts.get(draftKey(email, fileId, sheetId, date)) ?? null;
    },
    async writeDraft(email, fileId, sheetId, date, draft) {
      drafts.set(draftKey(email, fileId, sheetId, date), draft);
    },
    async clearDraft(email, fileId, sheetId, date) {
      drafts.delete(draftKey(email, fileId, sheetId, date));
    },
    async readMonth(email, fileId, sheetId) {
      return months.get(monthCacheKey(email, fileId, sheetId)) ?? null;
    },
    async writeMonth(email, fileId, sheetId, view) {
      months.set(monthCacheKey(email, fileId, sheetId), view);
    },
    async readRecent(email) {
      return recents.get(recentKey(email)) ?? [];
    },
    async addRecent(email, entry) {
      const key = recentKey(email);
      const next = addRecentFile(recents.get(key) ?? [], entry);
      recents.set(key, next);
      return next;
    },
    async readMembers(email) {
      return members.get(memberKey(email)) ?? [];
    },
    async addMember(email, member) {
      const key = memberKey(email);
      const next = addStoredMember(members.get(key) ?? [], member);
      members.set(key, next);
      return next;
    },
    async removeMember(email, memberEmail) {
      const key = memberKey(email);
      const next = removeStoredMember(members.get(key) ?? [], memberEmail);
      members.set(key, next);
      return next;
    },
  };
}

/** A store that holds nothing, used when IndexedDB cannot be opened at all. */
export function createNullStore(): LocalStore {
  return {
    async readDraft() {
      return null;
    },
    async writeDraft() {},
    async clearDraft() {},
    async readMonth() {
      return null;
    },
    async writeMonth() {},
    async readRecent() {
      return [];
    },
    async addRecent(_email, entry) {
      return [entry];
    },
    async readMembers() {
      return [];
    },
    async addMember(_email, member) {
      return [member];
    },
    async removeMember() {
      return [];
    },
  };
}

/* -------------------------------------------------------------------------- */
/* IndexedDB adapter                                                          */
/* -------------------------------------------------------------------------- */

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [DRAFT_STORE, MONTH_STORE, RECENT_STORE, MEMBER_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked."));
  });
}

/**
 * Opens the database lazily and only once. A failure is remembered as `null`
 * so a browser that refuses storage is not re-asked on every keystroke.
 */
function createConnection(factory: IDBFactory) {
  let pending: Promise<IDBDatabase | null> | null = null;

  return () => {
    pending ??= openDatabase(factory).catch(() => null);
    return pending;
  };
}

async function withStore<T>(
  connect: () => Promise<IDBDatabase | null>,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  try {
    const db = await connect();
    if (!db) return fallback;

    const transaction = db.transaction(storeName, mode);
    const result = await requestToPromise(run(transaction.objectStore(storeName)));
    return result as T;
  } catch {
    // Storage is unavailable or the record is unreadable; behave as if empty.
    return fallback;
  }
}

export function createIndexedDbStore(factory: IDBFactory): LocalStore {
  const connect = createConnection(factory);

  return {
    async readDraft(email, fileId, sheetId, date) {
      const stored = await withStore<unknown>(
        connect,
        DRAFT_STORE,
        "readonly",
        (store) => store.get(draftKey(email, fileId, sheetId, date)),
        null,
      );

      return isDraftRecord(stored) ? { day: stored.day, baseline: stored.baseline } : null;
    },

    async writeDraft(email, fileId, sheetId, date, draft) {
      await withStore(
        connect,
        DRAFT_STORE,
        "readwrite",
        (store) =>
          store.put(
            { email: email.trim().toLowerCase(), day: draft.day, baseline: draft.baseline },
            draftKey(email, fileId, sheetId, date),
          ),
        undefined,
      );
    },

    async clearDraft(email, fileId, sheetId, date) {
      await withStore(
        connect,
        DRAFT_STORE,
        "readwrite",
        (store) => store.delete(draftKey(email, fileId, sheetId, date)),
        undefined,
      );
    },

    async readMonth(email, fileId, sheetId) {
      const stored = await withStore<unknown>(
        connect,
        MONTH_STORE,
        "readonly",
        (store) => store.get(monthCacheKey(email, fileId, sheetId)),
        null,
      );

      return isMonthCacheRecord(stored) ? stored.view : null;
    },

    async writeMonth(email, fileId, sheetId, view) {
      await withStore(
        connect,
        MONTH_STORE,
        "readwrite",
        (store) =>
          store.put({ email: email.trim().toLowerCase(), view }, monthCacheKey(email, fileId, sheetId)),
        undefined,
      );
    },

    async readRecent(email) {
      const stored = await withStore<unknown>(
        connect,
        RECENT_STORE,
        "readonly",
        (store) => store.get(recentKey(email)),
        null,
      );

      return Array.isArray(stored) ? stored.filter(isRecentFile) : [];
    },

    async addRecent(email, entry) {
      const next = addRecentFile(await this.readRecent(email), entry);

      await withStore(
        connect,
        RECENT_STORE,
        "readwrite",
        (store) => store.put(next, recentKey(email)),
        undefined,
      );

      return next;
    },

    async readMembers(email) {
      const stored = await withStore<unknown>(
        connect,
        MEMBER_STORE,
        "readonly",
        (store) => store.get(memberKey(email)),
        null,
      );

      return Array.isArray(stored) ? stored.filter(isStoredMember) : [];
    },

    async addMember(email, member) {
      const next = addStoredMember(await this.readMembers(email), member);
      await writeMembers(connect, email, next);
      return next;
    },

    async removeMember(email, memberEmail) {
      const next = removeStoredMember(await this.readMembers(email), memberEmail);
      await writeMembers(connect, email, next);
      return next;
    },
  };
}

function writeMembers(
  connect: () => Promise<IDBDatabase | null>,
  email: string,
  members: readonly StoredMember[],
): Promise<void> {
  return withStore(
    connect,
    MEMBER_STORE,
    "readwrite",
    (store) => store.put([...members], memberKey(email)),
    undefined,
  );
}

/** The store the browser uses, or a null store when IndexedDB is absent. */
export function resolveLocalStore(): LocalStore {
  if (typeof indexedDB === "undefined") return createNullStore();
  return createIndexedDbStore(indexedDB);
}
