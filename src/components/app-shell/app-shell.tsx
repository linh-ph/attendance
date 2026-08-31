"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppNav } from "./app-nav";
import { FocusOnRouteChange } from "./focus-on-route-change";
import { ACCOUNT_NAV_ID, currentNavIds, initialsFromEmail } from "./navigation";

/**
 * The chrome every signed-in screen sits inside.
 *
 * One structure serves both shells (spec §3.1, §3.2). At `64rem` and above it
 * is a persistent left sidebar — brand, Calendar, Timesheets, a labelled
 * Management group, and the signed-in identity with Sign out at the foot. Below
 * that the same markup reflows into a sticky brand bar and a four-item bottom
 * navigation with 44 px targets, where `Manage` opens Managed files and `More`
 * owns account details and Sign out.
 *
 * The DOM is deliberately identical at both sizes: `shell.css` hides the
 * entries the other shell owns rather than rendering a second navigation, so
 * the two can never drift apart, and no viewport measurement happens in JS —
 * the shell is correct in the very first server-rendered byte.
 *
 * Screens do not render their own page frame; see `page-shell.tsx` for the slot
 * contract they render into.
 */

/** The skip link's destination, and what focus moves to after a navigation. */
export const MAIN_CONTENT_ID = "main-content";

export interface AppShellProps {
  /** The verified address from the server session. Displayed, never trusted. */
  readonly email: string;
  /**
   * The sign-out control. The server layout renders the form so the Auth.js
   * server action never has to cross into this client component.
   */
  readonly signOut: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({ email, signOut, children }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const current = currentNavIds(pathname);

  return (
    <div className="app-shell">
      {/*
       * First in the DOM, so it is the first stop for a keyboard user, and
       * off-screen until it takes focus.
       */}
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
        Skip to main content
      </a>

      <div className="app-sidebar">
        <header className="app-bar">
          <Link className="brand" href="/dashboard">
            <span className="brand-mark">blended-asia</span>
            <span className="brand-name">Attendance</span>
          </Link>
        </header>

        <AppNav current={current} />

        {/*
         * Desktop only. On a phone this identity lives behind `More`, which is
         * why the account link points there: the two shells reach one page.
         */}
        <div className="app-sidebar-footer">
          <Link
            className="app-account"
            href="/more"
            aria-current={current.has(ACCOUNT_NAV_ID) ? "page" : undefined}
          >
            <span className="app-account-mark" aria-hidden="true">
              {initialsFromEmail(email)}
            </span>
            <span className="app-account-copy">
              <span className="app-account-label">Account</span>
              <span className="app-account-email">{email}</span>
            </span>
          </Link>

          {signOut}
        </div>
      </div>

      <FocusOnRouteChange targetId={MAIN_CONTENT_ID} />

      {/*
       * The content region is focusable but not tabbable, so the skip link and
       * the post-navigation focus move can land here without adding a stop to
       * the tab order. Pages render their own `main` landmark inside it.
       */}
      <div className="app-main" id={MAIN_CONTENT_ID} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
