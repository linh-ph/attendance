import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { MemberForm } from "./member-form";

export const dynamic = "force-dynamic";

interface MembersPageProps {
  params: Promise<{ fileId: string }>;
}

/**
 * Server shell for the manage-members page.
 *
 * The identity is only checked here so an unauthenticated visitor is sent to
 * sign in; every roster read and every mutation is re-authorized against
 * current Drive ownership by `/api/files/[fileId]/members`.
 */
export default async function MembersPage({ params }: MembersPageProps) {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  const { fileId } = await params;

  return (
    <main>
      <section aria-labelledby="members-title">
        <p className="eyebrow">blended-asia</p>
        <h1 id="members-title">Manage members</h1>
        <MemberForm fileId={fileId} />
      </section>
    </main>
  );
}
