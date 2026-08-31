import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageShell } from "@/components/app-shell/page-shell";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

/**
 * Server shell for the role-aware dashboard.
 *
 * The proxy already blocks unauthenticated requests; this second check keeps
 * the identity server-derived, so the client component never has to be trusted
 * for who is signed in. The email only scopes the browser's remembered folder —
 * every listing is re-authorized by `GET /api/dashboard`.
 */
export default async function DashboardPage() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();

  if (!email) {
    redirect("/login");
  }

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Calendar"
      lede="See what is recorded, spot missing days, and open any day for detail."
    >
      <DashboardClient email={email} />
    </PageShell>
  );
}
