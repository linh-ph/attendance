import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await auth();

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <>
      {session?.user?.email ? (
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      ) : null}
      {children}
    </>
  );
}
