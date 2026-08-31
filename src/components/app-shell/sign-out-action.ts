"use server";

import { signOut } from "@/auth";

/**
 * The one sign-out action.
 *
 * Both shells offer Sign out — the sidebar foot on desktop, the `More` page on
 * a phone — and both must end the session the same way, so the action is
 * defined once here rather than inlined at each call site.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
