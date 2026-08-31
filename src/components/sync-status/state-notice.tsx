"use client";

import Link from "next/link";
import { useId, type CSSProperties, type ReactNode } from "react";
import {
  RECOVERY_LABELS,
  describeSystemState,
  type StateScope,
  type SystemStateId,
} from "./state-catalog";

/**
 * The renderer for the reusable state gallery — spec §8.2.
 *
 * A screen names a state; the words, the tone, and the default placement come
 * from the catalog. What the screen supplies is what only it can know: which
 * recovery it can actually perform, and which item failed.
 *
 * Two rules are enforced here rather than left to each screen:
 *
 * - **Scope decides blast radius.** A `card`-scoped state renders as a card
 *   error, so one unreadable file leaves the other nine on the dashboard alone.
 *   Only a state that invalidates the page renders page-level recovery.
 * - **A notice announces, an empty does not.** An empty list is the answer to
 *   a question the person just asked; a notice is a change of circumstances, so
 *   it goes into a polite live region — which reads without moving focus.
 */

export interface StateNoticeAction {
  label: string;
  /** A link for navigation; `onClick` for anything that acts in place. */
  href?: string;
  onClick?: () => void;
}

export interface StateNoticeProps {
  state: SystemStateId;
  /** Raises or lowers the catalog's default placement. Never rewords it. */
  scope?: StateScope;
  /** Names the item that failed, e.g. the workbook that was rejected. */
  title?: string;
  /** One more sentence, or a node, after the catalog's three answers. */
  detail?: ReactNode;
  onRetry?: () => void;
  onResume?: () => void;
  onReload?: () => void;
  /**
   * Re-authentication is a link, not a callback, so it needs no handler: it is
   * shown whenever the catalog calls for it. Pass `false` to suppress it.
   */
  reauthenticate?: boolean;
  /** One screen-specific action, such as `Choose timesheet`. */
  action?: StateNoticeAction;
  /** Disables every recovery control while one is already running. */
  busy?: boolean;
  /** Overrides the kind-derived default. */
  announce?: boolean;
  children?: ReactNode;
}

export function StateNotice({
  state,
  scope,
  title,
  detail,
  onRetry,
  onResume,
  onReload,
  reauthenticate,
  action,
  busy = false,
  announce,
  children,
}: StateNoticeProps) {
  const descriptor = describeSystemState(state);
  const titleId = useId();
  const placement = scope ?? descriptor.scope;
  const heading = title ?? descriptor.title;

  const wantsReauthenticate = reauthenticate ?? descriptor.recovery.includes("reauthenticate");
  const isAnnounced = announce ?? descriptor.kind === "notice";

  const handlers: ReadonlyArray<[label: string, handler: (() => void) | undefined]> = [
    [RECOVERY_LABELS.retry, descriptor.recovery.includes("retry") ? onRetry : undefined],
    [RECOVERY_LABELS.resume, descriptor.recovery.includes("resume") ? onResume : undefined],
    [RECOVERY_LABELS.reload, descriptor.recovery.includes("reload") ? onReload : undefined],
  ];
  const buttons = handlers.filter(([, handler]) => handler !== undefined);
  const hasActions = buttons.length > 0 || wantsReauthenticate || action !== undefined;

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={`state-notice state-notice-${placement} state-notice-${descriptor.kind}`}
      data-system-state={state}
    >
      <p className="state-notice-eyebrow">
        <span className={`state-pill ${descriptor.pillClass}`}>{descriptor.eyebrow}</span>
      </p>

      <h3 id={titleId} className="state-notice-title">
        {heading}
      </h3>

      <p className="state-notice-safety">{descriptor.dataSafety}</p>
      <p className="state-notice-guidance">{descriptor.guidance}</p>

      {detail ? <div className="state-notice-detail">{detail}</div> : null}
      {children}

      {hasActions ? (
        <div className="card-actions">
          {buttons.map(([label, handler]) => (
            <button
              key={label}
              type="button"
              className="btn-secondary"
              onClick={handler}
              disabled={busy}
            >
              {label}
            </button>
          ))}

          {/*
            A plain anchor, not `next/link`: re-authentication has to leave the
            client router and load the document, so the expired session is
            re-established rather than a stale client cache being reused.
          */}
          {wantsReauthenticate ? (
            <a className="action action-primary" href="/login">
              {RECOVERY_LABELS.reauthenticate}
            </a>
          ) : null}

          {action ? <StateNoticeActionControl action={action} busy={busy} /> : null}
        </div>
      ) : null}

      {isAnnounced ? (
        <p className="sr-only" role="status" aria-live="polite">
          {`${heading}. ${descriptor.dataSafety} ${descriptor.guidance}`}
        </p>
      ) : null}
    </div>
  );
}

function StateNoticeActionControl({ action, busy }: { action: StateNoticeAction; busy: boolean }) {
  if (action.href !== undefined) {
    return (
      <Link className="action" href={action.href}>
        {action.label}
      </Link>
    );
  }

  return (
    <button type="button" className="btn-secondary" onClick={action.onClick} disabled={busy}>
      {action.label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeletons                                                                   */
/* -------------------------------------------------------------------------- */

export interface StateSkeletonProps {
  /** Announced politely while the placeholder holds the space. */
  label: string;
  /** How many rows of final content are being reserved. */
  count?: number;
  variant?: "text" | "title" | "card" | "circle";
  /** The **final** width the real content will take, e.g. `18rem`. */
  width?: string;
  /** The **final** height the real content will take, e.g. `6rem`. */
  height?: string;
  className?: string;
}

/**
 * Placeholders that reserve the dimensions the real content will occupy, so
 * nothing shifts when it arrives — spec §9.
 *
 * The shapes are `aria-hidden`: a screen reader gets the one sentence in the
 * live region instead of a count of grey boxes. The sweep animation is stopped
 * by F1's reduced-motion block while the box still reads as a placeholder.
 */
export function StateSkeleton({
  label,
  count = 3,
  variant = "text",
  width,
  height,
  className,
}: StateSkeletonProps) {
  const style = {
    ...(width === undefined ? {} : { "--skeleton-w": width }),
    ...(height === undefined ? {} : { "--skeleton-h": height }),
  } as CSSProperties;

  return (
    <div className={["state-skeleton", className].filter(Boolean).join(" ")}>
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={`skeleton skeleton-${variant}`} style={style} />
        ))}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
    </div>
  );
}
