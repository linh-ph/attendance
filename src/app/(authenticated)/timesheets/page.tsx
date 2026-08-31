import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageShell } from "@/components/app-shell/page-shell";

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

  if (!session?.user?.email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Timesheets"
      lede="Every month you record hours in, with Open by link and Recent files."
    >
      <div className="empty-state">
        <p>Your timesheets are on the calendar dashboard while this page is being built.</p>
        <p>
          <Link className="action action-primary" href="/dashboard">
            Open the calendar
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
