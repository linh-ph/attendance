import type { Metadata } from "next";
import type { ReactNode } from "react";
// Ordered on purpose: tokens define what the rest reads, and the responsive
// and motion overrides come last so they win.
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
      <body>{children}</body>
    </html>
  );
}
