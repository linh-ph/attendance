import type { Metadata } from "next";
import type { ReactNode } from "react";
// Ordered on purpose: tokens define what the rest reads, and the responsive
// and motion overrides come last so they win.
import "react-day-picker/style.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/loading.css";
import "./styles/attendance.css";
import "./styles/manage.css";
import "./styles/responsive.css";

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
