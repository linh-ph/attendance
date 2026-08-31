import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageShell } from "@/components/app-shell/page-shell";
import { TimesheetsClient } from "./timesheets-client";

export const dynamic = "force-dynamic";

/**
 * Route shell for Timesheets.
 *
 * The shell task (F2) creates the route so no screen agent has to touch shared
 * routing; S3 fills it with the timesheet list, **Recent files**, and **Open by
 * link** (spec §3.4). Until then this page names the destination honestly and
 * points at the surfaces that carry the same work today.
 *
 * The identity check matches every other signed-in page: the proxy already
 * blocks anonymous requests, and this keeps the redirect behavior identical if
 * it ever does not.
 */
export default async function TimesheetsPage() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Timesheets"
      lede="Open an attendance month, return to a recent file, or paste an authorized Google Sheets link."
    >
      <TimesheetsClient email={email} />
    </PageShell>
  );
}
