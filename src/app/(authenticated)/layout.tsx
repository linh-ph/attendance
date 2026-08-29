import type { ReactNode } from "react";
import Link from "next/link";
import { auth, signOut } from "@/auth";

/**
 * Shell for every signed-in screen.
 *
 * The bar carries the product identity and the session controls so no page has
 * to render them, and so the sign-out control reads as chrome rather than as a
 * primary action floating above the content.
 */
export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await auth();
  const email = session?.user?.email ?? null;

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <>
      {email ? (
        <header className="app-bar">
          <Link className="brand" href="/dashboard">
            <span className="brand-mark">blended-asia</span>
            <span className="brand-name">Attendance</span>
          </Link>

          <span className="app-bar-spacer" />
          <span className="app-bar-user">{email}</span>

          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        </header>
      ) : null}

      {children}
    </>
  );
}
