import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { PageShell } from "@/components/app-shell/page-shell";
import { MemberRoster } from "./member-roster";

export const dynamic = "force-dynamic";

/**
 * Server shell for this browser's member roster.
 *
 * The roster is a convenience, not a record: it lives in `attendance-local`,
 * scoped to the signed-in address, and exists so creating next month's file
 * does not mean retyping the same colleagues. Nothing here grants access to
 * anything — every file operation still re-authorizes against Drive.
 *
 * The identity is checked so an unauthenticated visitor is sent to sign in, and
 * handed down because it scopes the storage key.
 */
export default async function MembersPage() {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Members"
      lede="Keep a reusable, browser-local roster for attendance file setup."
    >
      <MemberRoster email={email} />
    </PageShell>
  );
}
