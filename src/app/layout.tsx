import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Google Sheets Attendance",
  description: "Attendance management backed by Google Sheets.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await auth();

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <html lang="en">
      <body>
        {session?.user?.email ? (
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        ) : null}
        {children}
      </body>
    </html>
  );
}
