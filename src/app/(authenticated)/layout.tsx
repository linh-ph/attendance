import type { ReactNode } from "react";
import { currentUserEmail } from "@/lib/auth/current-user";
import { AppShell } from "@/components/app-shell/app-shell";
import { signOutAction } from "@/components/app-shell/sign-out-action";

/**
 * Shell for every signed-in screen.
 *
 * The identity is read from the verified server session here — never from the
 * client — and handed to `AppShell` for display only. Nothing about
 * authorization happens in the shell: every route and every mutation
 * re-authorizes itself against Drive, which is why the Management destinations
 * are always shown rather than gated on a role this application does not have.
 *
 * The sign-out form is built here so the Auth.js server action stays in a
 * server component; `AppShell` only places it.
 */
export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const email = await currentUserEmail();

  // Signed out, the page itself redirects to `/login`; rendering the chrome
  // around that redirect would flash a navigation the visitor cannot use.
  if (!email) {
    return <>{children}</>;
  }

  return (
    <AppShell
      email={email}
      signOut={
        <form className="app-sign-out" action={signOutAction}>
          <button className="btn-ghost btn-block" type="submit">
            Sign out
          </button>
        </form>
      }
    >
      {children}
    </AppShell>
  );
}
