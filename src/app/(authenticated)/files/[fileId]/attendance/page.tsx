import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { TabChooser } from "./tab-chooser";

export const dynamic = "force-dynamic";

interface TabChooserPageProps {
  params: Promise<{ fileId: string }>;
}

/**
 * Server shell for choosing which tab holds this person's hours.
 *
 * Reached for a file this app holds no configuration for, so there is nothing
 * that says which tab is theirs. The identity is checked here only so an
 * unauthenticated visitor is sent to sign in; the tab list comes from
 * `/api/dashboard`, computed with the signed-in user's own Google credentials.
 */
export default async function TabChooserPage({ params }: TabChooserPageProps) {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  const { fileId } = await params;

  return (
    <main>
      <section aria-labelledby="choose-tab-title">
        <p className="eyebrow">blended-asia</p>
        <h1 id="choose-tab-title">Choose your tab</h1>
        <TabChooser fileId={fileId} />
      </section>
    </main>
  );
}
