import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { TabChooser } from "./tab-chooser";

export const dynamic = "force-dynamic";

interface TabChooserPageProps {
  params: Promise<{ fileId: string }>;
  searchParams: Promise<{ choose?: string }>;
}

/**
 * Server shell for opening this person's tab in a file the app holds no
 * configuration for.
 *
 * Nothing here says which tab is theirs, but the tab titles and the work
 * address are both built from the same full name, so the browser resolves one
 * from the other and goes straight to the timesheet. Only a certain match
 * skips the list; anything ambiguous still shows it.
 *
 * The identity is checked here so an unauthenticated visitor is sent to sign
 * in, and the address is handed down because it is the thing being matched —
 * it comes from the verified session, never from the client.
 */
export default async function TabChooserPage({ params, searchParams }: TabChooserPageProps) {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  const { fileId } = await params;
  // `?choose=1` is the way back to the list once a match has been made, for
  // anyone whose tab is not the one their address spells.
  const { choose } = await searchParams;

  return (
    <main>
      <section aria-labelledby="choose-tab-title">
        <p className="eyebrow">blended-asia</p>
        <h1 id="choose-tab-title">Choose your tab</h1>
        <TabChooser fileId={fileId} email={email} autoOpen={choose !== "1"} />
      </section>
    </main>
  );
}
