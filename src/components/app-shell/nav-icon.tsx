import type { NavIconName } from "./navigation";

/**
 * The navigation glyphs.
 *
 * Every icon is decorative: the label beside it is the accessible name, so the
 * SVG is `aria-hidden` and carries no title. They are drawn as one-pixel
 * strokes on a 24-unit grid with `currentColor`, so a destination's colour and
 * its icon can never disagree, and the shape survives forced-colours mode.
 */

const PATHS: Record<NavIconName, readonly string[]> = {
  calendar: ["M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z", "M4 10h16", "M8 3v4", "M16 3v4"],
  timesheets: ["M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M14 3v5h5", "M8 13h8", "M8 17h5"],
  "managed-files": ["M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z", "M4 11h16"],
  members: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M3 20a6 6 0 0 1 12 0", "M16 5.5a3 3 0 0 1 0 6", "M17 14.5a5.5 5.5 0 0 1 4 5.5"],
  manage: ["M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z", "M4 11h16"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
};

export function NavIcon({ name }: Readonly<{ name: NavIconName }>) {
  return (
    <svg
      className="app-nav-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((definition) => (
        <path key={definition} d={definition} />
      ))}
    </svg>
  );
}
