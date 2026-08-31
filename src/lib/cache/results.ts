/**
 * Acknowledged results for every browser-cache operation.
 *
 * The old browser store degraded to a no-op whenever IndexedDB was unwilling,
 * which meant a rejected write reached the editor as silence and the editor
 * reported `Saved locally` for a draft that was never stored. The redesign
 * forbids that (spec §5.3, §5.6): **every** cache and draft call resolves to an
 * explicit success or an explicit, typed failure, and the caller decides what
 * to disclose.
 *
 * Nothing here performs I/O.
 */

/**
 * Why a cache operation could not be completed.
 *
 * - `unavailable` — no IndexedDB at all, or the database refused to open
 *   (private mode, disabled storage, a browser that denies the origin).
 * - `blocked` — another tab holds an older version open, so the upgrade cannot
 *   run. Retriable once that tab closes.
 * - `corrupt` — a stored record failed its structural guard, or the value could
 *   not be cloned into the store. Treated as a miss by the caller, but never
 *   silently: the record is left alone rather than deleted.
 * - `quota` — the browser refused the write for space.
 * - `migration-refused` — a schema change cannot carry a pending draft across,
 *   so nothing was touched. Drafts are never deleted to make a migration fit.
 * - `forbidden-content` — the value carried credential-shaped material. Refused
 *   before it reaches storage; see `findCredentialMaterial` in `keys.ts`.
 */
export type CacheFailureReason =
  | "unavailable"
  | "blocked"
  | "corrupt"
  | "quota"
  | "migration-refused"
  | "forbidden-content";

export interface CacheFailure {
  ok: false;
  reason: CacheFailureReason;
  /** Technical detail for a debug disclosure. The UI owns the human wording. */
  message: string;
}

export interface CacheSuccess<T> {
  ok: true;
  value: T;
}

export type CacheResult<T> = CacheSuccess<T> | CacheFailure;

export function ok<T>(value: T): CacheSuccess<T> {
  return { ok: true, value };
}

export function fail(reason: CacheFailureReason, message: string): CacheFailure {
  return { ok: false, reason, message };
}

/** A storage error that already knows which typed reason it is. */
export class CacheStorageError extends Error {
  readonly reason: CacheFailureReason;

  constructor(reason: CacheFailureReason, message: string) {
    super(message);
    this.name = "CacheStorageError";
    this.reason = reason;
  }
}

/**
 * Browsers report storage refusals through `DOMException` names rather than
 * types, so the name is the only stable signal. Anything unrecognized becomes
 * `unavailable` — never a success.
 */
const REASON_BY_ERROR_NAME: Readonly<Record<string, CacheFailureReason>> = {
  QuotaExceededError: "quota",
  NS_ERROR_DOM_QUOTA_REACHED: "quota",
  DataCloneError: "corrupt",
  DataError: "corrupt",
  ConstraintError: "corrupt",
  SecurityError: "unavailable",
  InvalidStateError: "unavailable",
  NotAllowedError: "unavailable",
  UnknownError: "unavailable",
  AbortError: "unavailable",
  VersionError: "blocked",
};

export function classifyStorageError(error: unknown): CacheFailure {
  if (error instanceof CacheStorageError) return fail(error.reason, error.message);

  if (error instanceof Error) {
    const reason = REASON_BY_ERROR_NAME[error.name];
    return fail(reason ?? "unavailable", error.message || error.name);
  }

  return fail("unavailable", "Browser storage rejected the operation.");
}
