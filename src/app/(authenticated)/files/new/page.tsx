import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { NewFileWizard } from "./new-file-wizard";

export const dynamic = "force-dynamic";

/**
 * Server shell for the create-monthly-file wizard.
 *
 * The proxy already blocks unauthenticated requests; this second check keeps
 * the identity server-derived. The email only scopes the browser's remembered
 * folder — the destination is revalidated and the owner is re-derived from the
 * session by `POST /api/files/create`.
 */
export default async function NewFilePage() {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  return (
    <main className="page">
      <NewFileWizard email={email} />
    </main>
  );
}
