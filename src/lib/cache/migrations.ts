/**
 * Schema migration decisions.
 *
 * Pure: no IndexedDB. `attendance-cache.ts` performs whatever this decides.
 *
 * Spec §5.6: a schema migration **may** replace a clean month cache, but must
 * preserve or safely refuse incompatible pending drafts rather than deleting
 * them silently. There is no application TTL on either, and both outlive
 * sign-out.
 *
 * Because the schema version is part of every key, a record written by an older
 * build is never *misread* — it is simply not found. Migration therefore only
 * decides what to do with those older records: drop a clean cache that is now
 * dead weight, or keep hands off entirely because a draft nobody can translate
 * is sitting there.
 */

import { parseCacheKey, type CacheContext, type ParsedCacheKey } from "./keys";

export interface MigrationInput {
  /** The version found in storage, or `null` when nothing is stored. */
  storedSchemaVersion: number | null;
  targetSchemaVersion: number;
  /** Dates of pending drafts stored under a version that is not the target. */
  pendingDraftDates: readonly string[];
}

export type MigrationDecision =
  | { action: "none" }
  | { action: "replace-clean" }
  | { action: "refuse"; reason: "pending-draft"; preservedDates: string[] };

export function planMigration(input: MigrationInput): MigrationDecision {
  const { storedSchemaVersion, targetSchemaVersion, pendingDraftDates } = input;

  if (storedSchemaVersion === null) return { action: "none" };
  if (storedSchemaVersion === targetSchemaVersion) return { action: "none" };

  // A draft written under another version cannot be translated by a reader that
  // does not know that shape. Refusing keeps it; deleting it would lose work.
  if (pendingDraftDates.length > 0) {
    return { action: "refuse", reason: "pending-draft", preservedDates: [...pendingDraftDates] };
  }

  return { action: "replace-clean" };
}

/* -------------------------------------------------------------------------- */
/* Key scanning                                                                */
/* -------------------------------------------------------------------------- */

export interface ScannedKey extends ParsedCacheKey {
  key: string;
}

export interface ScanOptions {
  /** Skip records already written under this version. */
  excludeSchemaVersion?: number;
}

function scan(
  keys: readonly string[],
  context: CacheContext,
  wantDraft: boolean,
  options: ScanOptions,
): ScannedKey[] {
  const account = context.email.trim().toLowerCase();

  return keys.flatMap((key) => {
    const parsed = parseCacheKey(key);
    if (parsed === null) return [];
    if (wantDraft !== (parsed.date !== null)) return [];
    if (options.excludeSchemaVersion === parsed.schemaVersion) return [];

    const matches =
      parsed.account === account &&
      parsed.fileId === context.fileId &&
      parsed.sheetId === context.sheetId &&
      parsed.month === context.month;

    return matches ? [{ ...parsed, key }] : [];
  });
}

/** This context's month records, under every schema version. */
export function monthKeysForContext(
  keys: readonly string[],
  context: CacheContext,
  options: ScanOptions = {},
): ScannedKey[] {
  return scan(keys, context, false, options);
}

/** This context's drafts, under every schema version, and nobody else's. */
export function draftKeysForContext(
  keys: readonly string[],
  context: CacheContext,
  options: ScanOptions = {},
): ScannedKey[] {
  return scan(keys, context, true, options);
}
