import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LegacySetupWizard } from "./legacy-setup-wizard";

export const dynamic = "force-dynamic";

interface SetupPageProps {
  params: Promise<{ fileId: string }>;
}

/**
 * Server shell for legacy attendance file setup.
 *
 * The identity is checked here only so an unauthenticated visitor is sent to
 * sign in, and the email merely scopes the browser's remembered folder. Nothing
 * on this page is authority: `/api/files/[fileId]/setup` re-derives ownership,
 * the current Drive name, and the parent folder, and requires the file to have
 * been selected in Google Picker before it reads or changes anything.
 */
export default async function SetupPage({ params }: SetupPageProps) {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  const { fileId } = await params;

  return (
    <main>
      <section aria-labelledby="setup-title">
        <p className="eyebrow">Google Sheets Attendance</p>
        <h1 id="setup-title">Set up this attendance file</h1>
        <LegacySetupWizard fileId={fileId} email={email} />
      </section>
    </main>
  );
}
