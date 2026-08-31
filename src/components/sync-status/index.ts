/**
 * F5's system-state module: everything a screen shows when it is *not* showing
 * the thing the person came for.
 *
 * Three pieces, and a screen should need nothing else:
 *
 * - **`SyncStatus`** and `sync-state` — the eight-state vocabulary of spec
 *   §5.4. One component, one set of words. A screen names a state; it never
 *   phrases one. If a screen needs a state that is not here, that is a gap to
 *   report, not a licence to write a ninth label.
 * - **`StateNotice` / `StateSkeleton`** and `state-catalog` — the fourteen
 *   reusable states of spec §8.2, each answering what happened, whether the
 *   data is safe, and what to do next.
 * - **`safe-diagnostic`** — the browser's own gate over a provider diagnostic.
 *   It lives beside the states because it is the same job: deciding what a
 *   failure is allowed to say. `ErrorNotice`, in
 *   [`../api-error-notice.tsx`](../api-error-notice.tsx), is its only caller.
 *
 * The `LoadingGhosts` waiting scene is the fourteenth state's first-load
 * companion and stays at [`../loading-ghosts.tsx`](../loading-ghosts.tsx),
 * where the screens already import it.
 */

export { SyncStatus, type SyncStatusProps } from "./sync-status";

export {
  SYNC_STATE_ORDER,
  describeSyncState,
  syncAnnouncement,
  syncTone,
  type SyncCause,
  type SyncState,
  type SyncStateDescriptor,
  type SyncTone,
} from "./sync-state";

export {
  StateNotice,
  StateSkeleton,
  type StateNoticeAction,
  type StateNoticeProps,
  type StateSkeletonProps,
} from "./state-notice";

export {
  RECOVERY_LABELS,
  SYSTEM_STATE_ORDER,
  describeSystemState,
  type RecoveryAction,
  type StateKind,
  type StateScope,
  type SystemStateDescriptor,
  type SystemStateId,
} from "./state-catalog";

export {
  MAX_DEBUG_FIELD_LENGTH,
  SAFE_DIAGNOSTIC_FIELDS,
  SAFE_DIAGNOSTIC_LABELS,
  sanitizeDiagnosticField,
  toSafeDiagnostic,
  type SafeDiagnostic,
  type SafeDiagnosticField,
} from "./safe-diagnostic";
