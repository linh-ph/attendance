import { redirect } from "next/navigation";
import { auth } from "@/auth";
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
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  return (
    <main>
      <section aria-labelledby="new-file-title">
        <p className="eyebrow">blended-asia</p>
        <h1 id="new-file-title">Create a monthly file</h1>
        <NewFileWizard email={email} />
      </section>
    </main>
  );
}
