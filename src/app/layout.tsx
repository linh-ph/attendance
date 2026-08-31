import type { Metadata } from "next";
import type { ReactNode } from "react";
/*
 * Every stylesheet in the application is registered here, and the order is the
 * cascade: tokens define what everything else reads, primitives define the
 * shared vocabulary, states and the shell sit on top of that, and each
 * per-surface sheet comes last so a screen can refine a primitive without
 * having to out-specify it.
 *
 * This list is deliberately complete rather than minimal — a surface's sheet is
 * registered even while it is thin, so the agent who fills it in never has to
 * edit this file. See `docs/patterns/ui-redesign-contract.md` for the ownership
 * table; this file itself has one owner and is frozen against screen work.
 */
import "react-day-picker/style.css";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./styles/states.css";
import "./styles/shell.css";
import "./styles/login.css";
import "./styles/calendar.css";
import "./styles/timesheets.css";
import "./styles/attendance.css";
import "./styles/manage.css";
import "./styles/members.css";
import "./styles/wizard.css";

export const metadata: Metadata = {
  title: "blended-asia Attendance",
  description: "Attendance management backed by Google Sheets.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      {/*
       * Extensions edit `<body>` before React hydrates — a password manager or
       * a colour picker adds its own attribute there — and React reports that
       * as a hydration mismatch the app cannot fix. Suppressing it on this one
       * element keeps the warning meaningful everywhere else: it does not
       * cascade to children, so a real mismatch inside the app still shows.
       */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
