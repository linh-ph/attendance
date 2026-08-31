import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageShell } from "@/components/app-shell/page-shell";

export const dynamic = "force-dynamic";

/**
 * Route shell for Managed files — the destination behind both the sidebar's
 * `Managed files` entry and the phone's `Manage` tab.
 *
 * F2 creates the route; S5 fills it with the managed-file hub. Members is its
 * sibling destination, which on a phone is only reachable through here, so the
 * link to it is part of the shell's information architecture rather than
 * placeholder content.
 *
 * Nothing here grants anything: every listing and every mutation behind these
 * links re-authorizes against Drive on the signed-in user's own credentials.
 */
export default async function ManagePage() {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Managed files"
      lede="The monthly attendance files you own, and the people they are shared with."
    >
      <section className="surface-panel" aria-labelledby="manage-destinations">
        <div className="section-header">
          <h2 id="manage-destinations">Where to go</h2>
        </div>

        <p>The managed-file list is on the calendar dashboard while this page is being built.</p>

        <p className="row">
          <Link className="action action-primary" href="/dashboard">
            Open the calendar
          </Link>
          <Link className="action" href="/members">
            Members
          </Link>
          <Link className="action" href="/files/new">
            Create a monthly file
          </Link>
          <Link className="action" href="/files/import">
            Import a workbook
          </Link>
        </p>
      </section>
    </PageShell>
  );
}
