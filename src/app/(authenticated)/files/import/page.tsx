import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ImportWizard } from "./import-wizard";

export const dynamic = "force-dynamic";

/**
 * Server shell for the `.xlsx` import wizard.
 *
 * The proxy already blocks unauthenticated requests; this second check keeps
 * the identity server-derived. The email only scopes the browser's remembered
 * folder — the workbook is re-checked, the destination revalidated, and the
 * owner re-derived from the session by `POST /api/files/import`.
 */
export default async function ImportFilePage() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  return (
    <main className="page">
      <ImportWizard email={email} />
    </main>
  );
}
