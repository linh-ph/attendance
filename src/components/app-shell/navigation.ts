/**
 * The navigation model — one list, rendered by both shells.
 *
 * Spec §3.1 and §3.2 require the desktop sidebar and the mobile bottom
 * navigation to expose the *same* information architecture under the *same*
 * names. The only durable way to guarantee that is to keep a single list and
 * mark which shell shows each entry, so a destination cannot be added to one
 * shell and forgotten on the other.
 *
 * Management is always present. It is not a role gate: ownership is defined per
 * file, creating a file is separately authorized, and every route and mutation
 * re-authorizes itself (see `docs/decisions/2026-08-29-app-is-a-sheets-client.md`).
 * It sits *after* Calendar and Timesheets so the daily work stays first.
 *
 * This module is pure — no React, no routing, no I/O — so the mapping from a
 * path to the current destination is testable on its own.
 */

/** Which shell shows a destination. */
export type NavSurface = "both" | "desktop" | "mobile";

/** The icon a destination draws; the glyphs live in `nav-icon.tsx`. */
export type NavIconName =
  | "calendar"
  | "timesheets"
  | "managed-files"
  | "members"
  | "manage"
  | "more";

export interface NavDestination {
  /** Stable identity, also what `currentNavIds` returns. */
  readonly id: string;
  /** The visible label. Identical on both shells wherever a destination is shared. */
  readonly label: string;
  readonly href: string;
  readonly icon: NavIconName;
  readonly surface: NavSurface;
}

/** Employee-first work. Always the top of the sidebar and the left of the bar. */
export const WORKSPACE_DESTINATIONS: readonly NavDestination[] = [
  {
    id: "calendar",
    label: "Calendar",
    href: "/dashboard",
    icon: "calendar",
    surface: "both",
  },
  {
    id: "timesheets",
    label: "Timesheets",
    href: "/timesheets",
    icon: "timesheets",
    surface: "both",
  },
];

/** The visually labelled Management group. Desktop shows both entries. */
export const MANAGEMENT_DESTINATIONS: readonly NavDestination[] = [
  {
    id: "managed-files",
    label: "Managed files",
    href: "/manage",
    icon: "managed-files",
    surface: "desktop",
  },
  {
    id: "members",
    label: "Members",
    href: "/members",
    icon: "members",
    surface: "desktop",
  },
];

/**
 * The two entries that exist only where four slots is the whole budget.
 *
 * `Manage` opens Managed files — the same route the sidebar entry opens — and
 * the Managed files page offers Members as a sibling destination. `More` owns
 * account details and Sign out, which the sidebar carries at its foot. No Help
 * or Settings destination exists; spec §3.2 forbids introducing one.
 */
export const COMPACT_DESTINATIONS: readonly NavDestination[] = [
  {
    id: "manage",
    label: "Manage",
    href: "/manage",
    icon: "manage",
    surface: "mobile",
  },
  {
    id: "more",
    label: "More",
    href: "/more",
    icon: "more",
    surface: "mobile",
  },
];

/** Every destination, in the order the shell renders them. */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  ...WORKSPACE_DESTINATIONS,
  ...MANAGEMENT_DESTINATIONS,
  ...COMPACT_DESTINATIONS,
];

/** The id the sidebar's signed-in identity link answers to. */
export const ACCOUNT_NAV_ID = "account";

const ATTENDANCE_ROUTE = /^\/files\/[^/]+\/attendance(\/|$)/;
const FILE_MEMBERS_ROUTE = /^\/files\/[^/]+\/members(\/|$)/;

/** Drops a trailing slash and anything a caller appended after the path. */
function normalizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";

  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }

  return path;
}

function isUnder(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

/**
 * Which destinations are the current page.
 *
 * More than one id can be current because the two shells group the same routes
 * differently: on mobile `Manage` owns both Managed files and Members, so the
 * member roster marks `members` (sidebar) and `manage` (bottom bar). Only one
 * of the two is ever exposed, because the other shell is `display: none`.
 */
export function currentNavIds(pathname: string): ReadonlySet<string> {
  const path = normalizePath(pathname);

  if (isUnder(path, "/timesheets") || ATTENDANCE_ROUTE.test(path)) {
    return new Set(["timesheets"]);
  }

  if (isUnder(path, "/members") || FILE_MEMBERS_ROUTE.test(path)) {
    return new Set(["members", "manage"]);
  }

  if (isUnder(path, "/manage") || isUnder(path, "/files")) {
    return new Set(["managed-files", "manage"]);
  }

  if (isUnder(path, "/more")) {
    return new Set(["more", ACCOUNT_NAV_ID]);
  }

  if (isUnder(path, "/dashboard")) {
    return new Set(["calendar"]);
  }

  return new Set();
}

/**
 * A two-letter mark for the signed-in address.
 *
 * Decorative only — the account control always spells the address out, so this
 * is `aria-hidden` wherever it is drawn and never the accessible name.
 */
export function initialsFromEmail(email: string): string {
  const local = email.split("@", 1)[0] ?? "";
  const words = local.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

  if (words.length === 0) {
    return "?";
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
