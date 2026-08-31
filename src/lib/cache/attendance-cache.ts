/**
 * The acknowledged, versioned, multi-tab-safe attendance cache.
 *
 * This replaces a store that "degraded to a no-op when IndexedDB is
 * unavailable". Spec §5.3 and §5.6 forbid that: a rejected write must never
 * reach the person as `Saved locally`. So **every** method here resolves to a
 * `CacheResult` — an explicit success, or a typed failure the UI can disclose
 * honestly (`Local storage unavailable`, `Saved to Google Sheets · local cache
 * unavailable`).
 *
 * The ordering rules of spec §5.5 are implemented as transactional comparisons,
 * not as hopeful sequencing:
 *
 * - **Epochs.** A context owns a monotonically increasing request epoch. A load
 *   or revalidation may touch state or storage only while its context is still
 *   selected and its epoch is the latest issued (`epochs.ts`).
 * - **Revisions.** Every draft write advances a local revision. A Save clears a
 *   draft only when the stored revision equals the one it sent, so an edit made
 *   while the request was in flight stays pending.
 * - **Captured baselines.** A revalidation that started before a Save passes
 *   the month revision it saw; the comparison happens *inside* the transaction,
 *   so it cannot replace the newer post-Save baseline.
 * - **Two tabs.** Both tabs run the same comparison against the same shared
 *   database, so the stale one is refused rather than silently winning, and a
 *   broadcast tells it to re-read.
 *
 * Nothing here is authoritative. The server re-reads the sheet and
 * re-authorizes every request; this is a head start, never a second source of
 * truth. No credential material can be stored — the guard in `keys.ts` refuses
 * the write outright.
 */

import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView } from "@/lib/attendance/service";
import {
  CACHE_DRAFT_STORE,
  CACHE_MONTH_STORE,
  CacheStorageError,
  resolveCacheEngine,
  type CacheEngine,
  type CacheTransaction,
  type TransactionMode,
} from "./engine";
import {
  createNullBroadcast,
  resolveRevisionBroadcast,
  type RevisionBroadcast,
  type RevisionListener,
} from "./broadcast";
import { createEpochRegistry, type EpochRegistry } from "./epochs";
import {
  CACHE_SCHEMA_VERSION,
  contextKey,
  draftCacheKey,
  findCredentialMaterial,
  monthCacheKey,
  type CacheContext,
} from "./keys";
import { draftKeysForContext, monthKeysForContext, planMigration } from "./migrations";
import {
  buildDraftRecord,
  buildMonthRecord,
  isCachedDraftRecord,
  isCachedMonthRecord,
  type CachedDraftRecord,
  type CachedMonthRecord,
} from "./records";
import { INITIAL_REVISION, hashDay, nextRevision, sameBaseline } from "./revisions";
import { classifyStorageError, fail, ok, type CacheFailureReason, type CacheResult } from "./results";

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

export interface WriteMonthInput {
  view: AttendanceMonthView;
  /** ISO timestamp of the successful Sheet check this response came from. */
  checkedAt: string;
  /** The epoch this response was issued under. Omit for an unordered write. */
  epoch?: number;
  /**
   * The month revision captured *before* the fetch began; `null` means "there
   * was no record". Omit to write unconditionally.
   */
  expectedRevision?: number | null;
}

export type MonthWriteOutcome =
  | {
      status: "written";
      record: CachedMonthRecord;
      /** Dates whose remote row differs from the row previously cached. */
      changedDates: string[];
      /** Changed dates that also have a pending draft — `Remote changes detected`. */
      conflictedDates: string[];
    }
  | { status: "superseded"; reason: "stale-epoch" }
  | { status: "superseded"; reason: "revision-advanced"; current: CachedMonthRecord | null };

export interface WriteDraftInput {
  day: AttendanceDay;
  baseline: AttendanceDay;
  /** The revision this tab believes is stored; `0`/`null` means "none". */
  expectedRevision?: number | null;
}

export type DraftWriteOutcome =
  | { status: "written"; record: CachedDraftRecord }
  | { status: "superseded"; reason: "revision-advanced"; current: CachedDraftRecord | null };

export interface ClearDraftOptions {
  expectedRevision?: number | null;
}

export type ClearDraftOutcome =
  | { status: "cleared"; revision: number }
  | { status: "absent" }
  | { status: "superseded"; reason: "revision-advanced"; current: CachedDraftRecord };

export type RestoreDraftOutcome =
  | { status: "restored"; record: CachedDraftRecord }
  | { status: "absent" }
  | { status: "discarded"; reason: "baseline-changed"; revision: number };

export interface CommitSaveInput {
  date: string;
  /** The row as the Sheet confirmed it. Becomes the new baseline. */
  confirmedDay: AttendanceDay;
  /** The draft revision included in the request. Only this one is cleared. */
  sentRevision: number;
  checkedAt: string;
}

export interface CommitSaveOutcome {
  status: "committed";
  monthUpdated: boolean;
  monthRevision: number | null;
  draftCleared: boolean;
  /** Non-null when an edit arrived during the Save and is still pending. */
  pendingRevision: number | null;
}

export interface MigrationOutcome {
  action: "none" | "replace-clean";
  removedKeys: string[];
}

export interface AttendanceCache {
  /** Issues a fresh epoch and makes this context the selected one. */
  select(context: CacheContext): number;
  /** Issues a fresh epoch without changing the selection. */
  issue(context: CacheContext): number;
  /** True only while this context is selected and `epoch` is its latest. */
  accepts(context: CacheContext, epoch: number): boolean;

  readMonth(context: CacheContext): Promise<CacheResult<CachedMonthRecord | null>>;
  writeMonth(context: CacheContext, input: WriteMonthInput): Promise<CacheResult<MonthWriteOutcome>>;

  readDraft(context: CacheContext, date: string): Promise<CacheResult<CachedDraftRecord | null>>;
  writeDraft(
    context: CacheContext,
    date: string,
    input: WriteDraftInput,
  ): Promise<CacheResult<DraftWriteOutcome>>;
  clearDraft(
    context: CacheContext,
    date: string,
    options?: ClearDraftOptions,
  ): Promise<CacheResult<ClearDraftOutcome>>;
  /** Restores a stored draft only onto a byte-for-byte identical baseline. */
  restoreDraft(
    context: CacheContext,
    date: string,
    remoteBaseline: AttendanceDay,
  ): Promise<CacheResult<RestoreDraftOutcome>>;

  /** One transaction: advance the baseline, clear only the revision sent. */
  commitSave(context: CacheContext, input: CommitSaveInput): Promise<CacheResult<CommitSaveOutcome>>;

  migrate(context: CacheContext): Promise<CacheResult<MigrationOutcome>>;

  onRevisionChanged(listener: RevisionListener): () => void;
  close(): void;
}

export interface AttendanceCacheOptions {
  engine: CacheEngine;
  broadcast?: RevisionBroadcast;
  epochs?: EpochRegistry;
  schemaVersion?: number;
  now?: () => string;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

const BOTH_STORES = [CACHE_MONTH_STORE, CACHE_DRAFT_STORE];

/** `0` and `null` both mean "no draft is stored". */
function normalizeExpectedDraftRevision(value: number | null): number {
  return value ?? INITIAL_REVISION;
}

function refuseCredentials(value: unknown): CacheResult<never> | null {
  const found = findCredentialMaterial(value);
  if (found === null) return null;

  return fail(
    "forbidden-content",
    `Refused to store credential-shaped material at "${found}". Tokens, cookies, and secrets never enter IndexedDB.`,
  );
}

export function createAttendanceCache(options: AttendanceCacheOptions): AttendanceCache {
  const { engine } = options;
  const broadcast = options.broadcast ?? createNullBroadcast();
  const epochs = options.epochs ?? createEpochRegistry();
  const schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const now = options.now ?? (() => new Date().toISOString());

  const monthKeyOf = (context: CacheContext) => monthCacheKey(context, schemaVersion);
  const draftKeyOf = (context: CacheContext, date: string) =>
    draftCacheKey(context, date, schemaVersion);

  /** Wraps one transaction so a refusal always arrives as a typed failure. */
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

  async function readMonthRecord(
    tx: CacheTransaction,
    context: CacheContext,
  ): Promise<CachedMonthRecord | null> {
    const raw = await tx.get(CACHE_MONTH_STORE, monthKeyOf(context));
    if (raw === undefined) return null;

    if (!isCachedMonthRecord(raw)) {
      throw new CacheStorageError("corrupt", "The cached month could not be read and was left in place.");
    }

    return raw;
  }

  async function readDraftRecord(
    tx: CacheTransaction,
    context: CacheContext,
    date: string,
  ): Promise<CachedDraftRecord | null> {
    const raw = await tx.get(CACHE_DRAFT_STORE, draftKeyOf(context, date));
    if (raw === undefined) return null;

    if (!isCachedDraftRecord(raw)) {
      throw new CacheStorageError("corrupt", "The stored draft could not be read and was left in place.");
    }

    return raw;
  }

  return {
    select: (context) => epochs.select(contextKey(context, schemaVersion)),
    issue: (context) => epochs.issue(contextKey(context, schemaVersion)),
    accepts: (context, epoch) => epochs.accepts(contextKey(context, schemaVersion), epoch),

    onRevisionChanged: (listener) => broadcast.subscribe(listener),

    close() {
      broadcast.close();
      engine.close();
    },

    /* ---------------------------------------------------------------- month */

    readMonth(context) {
      return run([CACHE_MONTH_STORE], "readonly", (tx) => readMonthRecord(tx, context));
    },

    async writeMonth(context, input) {
      const refused = refuseCredentials({ view: input.view });
      if (refused) return refused;

      // Spec §5.5: a superseded response may not touch storage at all.
      if (input.epoch !== undefined && !epochs.accepts(contextKey(context, schemaVersion), input.epoch)) {
        return ok({ status: "superseded", reason: "stale-epoch" });
      }

      const result = await run<MonthWriteOutcome>(BOTH_STORES, "readwrite", async (tx) => {
        const stored = await readMonthRecord(tx, context);

        // The captured-baseline comparison happens inside the transaction, so a
        // revalidation that started before a Save cannot replace its baseline.
        if (input.expectedRevision !== undefined && (stored?.revision ?? null) !== input.expectedRevision) {
          return { status: "superseded", reason: "revision-advanced", current: stored };
        }

        const record = buildMonthRecord({
          context,
          schemaVersion,
          view: input.view,
          checkedAt: input.checkedAt,
          revision: nextRevision(stored?.revision ?? null),
        });

        const changedDates = Object.keys(record.baselineHashes).filter((date) => {
          const previous = stored?.baselineHashes[date];
          return previous !== undefined && previous !== record.baselineHashes[date];
        });

        const conflictedDates: string[] = [];
        for (const date of changedDates) {
          const pending = await tx.get(CACHE_DRAFT_STORE, draftKeyOf(context, date));
          if (pending !== undefined) conflictedDates.push(date);
        }

        await tx.put(CACHE_MONTH_STORE, monthKeyOf(context), record);

        return { status: "written", record, changedDates, conflictedDates };
      });

      if (result.ok && result.value.status === "written") {
        broadcast.publish({
          scope: "month",
          key: monthKeyOf(context),
          revision: result.value.record.revision,
        });
      }

      return result;
    },

    /* ---------------------------------------------------------------- draft */

    readDraft(context, date) {
      return run([CACHE_DRAFT_STORE], "readonly", (tx) => readDraftRecord(tx, context, date));
    },

    async writeDraft(context, date, input) {
      const refused = refuseCredentials({ day: input.day, baseline: input.baseline });
      if (refused) return refused;

      const result = await run<DraftWriteOutcome>([CACHE_DRAFT_STORE], "readwrite", async (tx) => {
        const raw = await tx.get(CACHE_DRAFT_STORE, draftKeyOf(context, date));
        // An unreadable record is overwritten by the person's current work:
        // nothing recoverable is lost, and refusing would strand the date.
        const stored = isCachedDraftRecord(raw) ? raw : null;

        if (
          input.expectedRevision !== undefined &&
          (stored?.revision ?? INITIAL_REVISION) !==
            normalizeExpectedDraftRevision(input.expectedRevision)
        ) {
          return { status: "superseded", reason: "revision-advanced", current: stored };
        }

        const record = buildDraftRecord({
          context,
          schemaVersion,
          date,
          day: input.day,
          baseline: input.baseline,
          revision: nextRevision(stored?.revision ?? null),
          updatedAt: now(),
        });

        await tx.put(CACHE_DRAFT_STORE, draftKeyOf(context, date), record);

        return { status: "written", record };
      });

      if (result.ok && result.value.status === "written") {
        broadcast.publish({
          scope: "draft",
          key: draftKeyOf(context, date),
          revision: result.value.record.revision,
        });
      }

      return result;
    },

    async clearDraft(context, date, clearOptions = {}) {
      const result = await run<ClearDraftOutcome>([CACHE_DRAFT_STORE], "readwrite", async (tx) => {
        const stored = await readDraftRecord(tx, context, date);
        if (stored === null) return { status: "absent" };

        if (
          clearOptions.expectedRevision !== undefined &&
          stored.revision !== normalizeExpectedDraftRevision(clearOptions.expectedRevision)
        ) {
          return { status: "superseded", reason: "revision-advanced", current: stored };
        }

        await tx.delete(CACHE_DRAFT_STORE, draftKeyOf(context, date));

        return { status: "cleared", revision: stored.revision };
      });

      if (result.ok && result.value.status === "cleared") {
        broadcast.publish({
          scope: "draft",
          key: draftKeyOf(context, date),
          revision: result.value.revision,
        });
      }

      return result;
    },

    restoreDraft(context, date, remoteBaseline) {
      return run<RestoreDraftOutcome>([CACHE_DRAFT_STORE], "readwrite", async (tx) => {
        const stored = await readDraftRecord(tx, context, date);
        if (stored === null) return { status: "absent" };

        // Spec §5.2: restored only onto a byte-for-byte identical baseline;
        // otherwise discarded with a notice, never replayed over newer data.
        if (!sameBaseline(stored.baseline, remoteBaseline)) {
          await tx.delete(CACHE_DRAFT_STORE, draftKeyOf(context, date));
          return { status: "discarded", reason: "baseline-changed", revision: stored.revision };
        }

        return { status: "restored", record: stored };
      });
    },

    /* ----------------------------------------------------------------- save */

    async commitSave(context, input) {
      const refused = refuseCredentials({ day: input.confirmedDay });
      if (refused) return refused;

      const result = await run<CommitSaveOutcome>(BOTH_STORES, "readwrite", async (tx) => {
        const draft = await readDraftRecord(tx, context, input.date);

        let draftCleared = false;
        let pendingRevision: number | null = null;

        if (draft !== null) {
          if (draft.revision === input.sentRevision) {
            await tx.delete(CACHE_DRAFT_STORE, draftKeyOf(context, input.date));
            draftCleared = true;
          } else {
            // An edit arrived while the request was in flight. It stays pending.
            pendingRevision = draft.revision;
          }
        }

        const month = await readMonthRecord(tx, context);
        let monthRevision: number | null = null;

        if (month !== null) {
          const record: CachedMonthRecord = {
            ...month,
            revision: nextRevision(month.revision),
            checkedAt: input.checkedAt,
            view: {
              ...month.view,
              days: month.view.days.map((day) =>
                day.date === input.date ? input.confirmedDay : day,
              ),
            },
            baselineHashes: {
              ...month.baselineHashes,
              [input.date]: hashDay(input.confirmedDay),
            },
          };

          await tx.put(CACHE_MONTH_STORE, monthKeyOf(context), record);
          monthRevision = record.revision;
        }

        return {
          status: "committed",
          monthUpdated: month !== null,
          monthRevision,
          draftCleared,
          pendingRevision,
        };
      });

      if (result.ok && result.value.monthRevision !== null) {
        broadcast.publish({
          scope: "month",
          key: monthKeyOf(context),
          revision: result.value.monthRevision,
        });
      }

      return result;
    },

    /* ------------------------------------------------------------ migration */

    migrate(context) {
      return run<MigrationOutcome>(BOTH_STORES, "readwrite", async (tx) => {
        const monthKeys = await tx.keys(CACHE_MONTH_STORE);
        const draftKeys = await tx.keys(CACHE_DRAFT_STORE);

        const foreignMonths = monthKeysForContext(monthKeys, context, {
          excludeSchemaVersion: schemaVersion,
        });
        const foreignDrafts = draftKeysForContext(draftKeys, context, {
          excludeSchemaVersion: schemaVersion,
        });

        const decision = planMigration({
          storedSchemaVersion:
            foreignMonths[0]?.schemaVersion ?? foreignDrafts[0]?.schemaVersion ?? null,
          targetSchemaVersion: schemaVersion,
          pendingDraftDates: foreignDrafts.flatMap((entry) => (entry.date === null ? [] : [entry.date])),
        });

        if (decision.action === "refuse") {
          // Nothing is deleted. The drafts stay exactly where they are.
          throw new CacheStorageError(
            "migration-refused",
            `A pending draft from an older cache version cannot be carried across (${decision.preservedDates.join(", ")}). It was preserved and nothing was removed.`,
          );
        }

        if (decision.action === "none") return { action: "none", removedKeys: [] };

        for (const entry of foreignMonths) await tx.delete(CACHE_MONTH_STORE, entry.key);

        return { action: "replace-clean", removedKeys: foreignMonths.map((entry) => entry.key) };
      });
    },
  };
}

/**
 * A cache that answers every call with the same explicit failure.
 *
 * This is the honest replacement for the old null store. It is not a no-op:
 * a caller cannot mistake it for a successful write, because there is no code
 * path through it that returns success.
 */
export function createUnavailableCache(reason: CacheFailureReason, message: string): AttendanceCache {
  const epochs = createEpochRegistry();
  const refusal = async () => fail(reason, message);

  return {
    select: (context) => epochs.select(contextKey(context)),
    issue: (context) => epochs.issue(contextKey(context)),
    accepts: (context, epoch) => epochs.accepts(contextKey(context), epoch),

    readMonth: refusal,
    writeMonth: refusal,
    readDraft: refusal,
    writeDraft: refusal,
    clearDraft: refusal,
    restoreDraft: refusal,
    commitSave: refusal,
    migrate: refusal,

    onRevisionChanged: () => () => {},
    close() {},
  };
}

/** The cache this browser can use; an acknowledged refusal when it cannot. */
export function resolveAttendanceCache(): AttendanceCache {
  const engine = resolveCacheEngine();

  if (engine === null) {
    return createUnavailableCache(
      "unavailable",
      "This browser has no IndexedDB, so nothing can be kept locally.",
    );
  }

  return createAttendanceCache({ engine, broadcast: resolveRevisionBroadcast() });
}
