import type { ReactNode } from "react";
import { describeSyncState, type SyncCause, type SyncState } from "./sync-state";

/**
 * The one component that says how a day, a month, or a file stands with Google
 * Sheets — spec §5.4 and §10.
 *
 * It is a polite live region and nothing else: the text changes when the state
 * changes and a screen reader reads it in place. Nothing here focuses, scrolls,
 * or opens anything, because a status must never take the caret away from
 * whatever the person was typing.
 *
 * The announcement is the element's own text, so there is no second hidden copy
 * to keep in sync, and no effect is needed to push an announcement — React
 * re-rendering the text is the announcement.
 */

export interface SyncStatusProps {
  /** One of the eight states from spec §5.4. */
  state: SyncState;
  /** Sharpens `Needs attention` into a failure tone. Ignored by other states. */
  cause?: SyncCause;
  /** One extra sentence from the screen, such as the failing validation rule. */
  detail?: ReactNode;
  /** e.g. `Last checked 2 min ago`. Shown, never announced on its own. */
  lastCheckedLabel?: string;
  /**
   * `false` renders the badge without the live region — for a calendar cell or
   * a list row, where the state is decoration beside a thing that already has
   * a name, not a status change worth reading aloud.
   */
  announce?: boolean;
  className?: string;
}

export function SyncStatus({
  state,
  cause,
  detail,
  lastCheckedLabel,
  announce = true,
  className,
}: SyncStatusProps) {
  const descriptor = describeSyncState(state, cause);
  const liveProps = announce ? ({ role: "status", "aria-live": "polite" } as const) : {};

  return (
    <p
      {...liveProps}
      className={["sync-status", "live-region", className].filter(Boolean).join(" ")}
      data-sync-state={state}
      data-sync-tone={descriptor.tone}
    >
      <span className={`state-pill ${descriptor.pillClass}`}>{descriptor.label}</span>

      {announce ? (
        <span className="sync-status-detail">
          {`— ${descriptor.detail}. ${descriptor.action}.`}
        </span>
      ) : null}

      {detail ? <span className="sync-status-detail">{detail}</span> : null}

      {lastCheckedLabel ? (
        <span className="sync-status-meta tabular">{lastCheckedLabel}</span>
      ) : null}
    </p>
  );
}
