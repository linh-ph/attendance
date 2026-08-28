import { redirect } from "next/navigation";
import { auth } from "@/auth";
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
    <main>
      <section aria-labelledby="dashboard-title">
        <p className="eyebrow">Google Sheets Attendance</p>
        <h1 id="dashboard-title">Dashboard</h1>
        <DashboardClient email={email} />
      </section>
    </main>
  );
}
