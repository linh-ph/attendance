import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageShell } from "@/components/app-shell/page-shell";
import { ManageClient } from "./manage-client";

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
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Managed files"
      lede="Create, resume, repair, and open the attendance files you manage."
      actions={
        <Link className="action" href="/members">
          Members
        </Link>
      }
    >
      <ManageClient email={email} />
    </PageShell>
  );
}
