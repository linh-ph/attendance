import { redirect } from "next/navigation";
import { auth } from "@/auth";
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
  const session = await auth();
  const email = session?.user?.email;

  if (!email) {
    redirect("/login");
  }

  return (
    <main>
      <section aria-labelledby="roster-title">
        <p className="eyebrow">blended-asia</p>
        <h1 id="roster-title">Members</h1>
        <MemberRoster email={email} />
      </section>
    </main>
  );
}
