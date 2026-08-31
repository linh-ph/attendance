import Link from "next/link";
import { NavIcon } from "./nav-icon";
import {
  COMPACT_DESTINATIONS,
  MANAGEMENT_DESTINATIONS,
  WORKSPACE_DESTINATIONS,
  type NavDestination,
} from "./navigation";

/**
 * One navigation element, two shells.
 *
 * The desktop sidebar and the mobile bottom bar are the *same* `<nav>`: the
 * shell reflows it with CSS and hides the entries the other shell owns. That
 * is deliberate — a second `<nav>` would mean a second landmark, a second copy
 * of every label, and two places to forget a destination.
 *
 * Because only one shell's entries are ever displayed, the hidden ones are out
 * of the accessibility tree and out of the keyboard order too: `display: none`
 * removes them from both.
 */

const MANAGEMENT_LABEL_ID = "app-nav-management";

function NavLink({
  destination,
  current,
}: Readonly<{ destination: NavDestination; current: ReadonlySet<string> }>) {
  const isCurrent = current.has(destination.id);

  return (
    <li className="app-nav-item" data-surface={destination.surface}>
      <Link
        className="app-nav-link"
        href={destination.href}
        aria-current={isCurrent ? "page" : undefined}
      >
        {/* The box, not the glyph, carries the current-destination wash. */}
        <span className="app-nav-icon-box" aria-hidden="true">
          <NavIcon name={destination.icon} />
        </span>
        <span className="app-nav-label">{destination.label}</span>
      </Link>
    </li>
  );
}

export function AppNav({ current }: Readonly<{ current: ReadonlySet<string> }>) {
  return (
    <nav className="app-nav" aria-label="Main">
      <ul className="app-nav-list">
        {WORKSPACE_DESTINATIONS.map((destination) => (
          <NavLink key={destination.id} destination={destination} current={current} />
        ))}

        {/*
         * Management is always visible, never a role gate. It is a labelled
         * group rather than four flat entries so it reads as secondary to the
         * daily work above it — on screen and to a screen reader alike.
         */}
        <li className="app-nav-group" data-surface="desktop">
          <span className="app-nav-group-label" id={MANAGEMENT_LABEL_ID}>
            Management
          </span>
          <ul className="app-nav-list app-nav-sublist" aria-labelledby={MANAGEMENT_LABEL_ID}>
            {MANAGEMENT_DESTINATIONS.map((destination) => (
              <NavLink key={destination.id} destination={destination} current={current} />
            ))}
          </ul>
        </li>

        {COMPACT_DESTINATIONS.map((destination) => (
          <NavLink key={destination.id} destination={destination} current={current} />
        ))}
      </ul>
    </nav>
  );
}
