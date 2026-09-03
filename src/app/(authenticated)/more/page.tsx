import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { PageShell } from "@/components/app-shell/page-shell";
import { signOutAction } from "@/components/app-shell/sign-out-action";
import { SyncSettings } from "@/components/settings/sync-settings";

export const dynamic = "force-dynamic";

/**
 * Account details and Sign out — the phone's `More` destination, and where the
 * sidebar's identity link points on desktop, so both shells reach one page.
 *
 * This page belongs to the shell rather than to a screen task: it exists only
 * because a four-slot bottom navigation cannot also carry the identity the
 * sidebar shows at its foot. It introduces **no** Help or Settings destination
 * — spec §3.2 forbids one — and holds only things that belong to this browser
 * and this session: the signed-in address, the manual sync, and sign out.
 */
export default async function MorePage() {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  return (
    <PageShell eyebrow="blended-asia" title="More" lede="Your account and this session.">
      <section className="surface-panel" aria-labelledby="account-title">
        <div className="section-header">
          <h2 id="account-title">Account</h2>
        </div>

        <dl className="card-facts">
          <div className="card-fact">
            <dt>Signed in as</dt>
            <dd>{email}</dd>
          </div>
        </dl>

        <p className="page-lede">
          Everything this application reads or writes runs on your own Google
          account, so you can only reach the files Google already shares with you.
        </p>

        <form className="app-sign-out" action={signOutAction}>
          <button className="btn-secondary" type="submit">
            Sign out
          </button>
        </form>
      </section>

      {/*
        The email is normalized here rather than in the client component: it
        scopes this browser's cached records, and a scope key must be derived
        from the verified session, never from anything the client supplies.
      */}
      <SyncSettings email={email.trim().toLowerCase()} />
    </PageShell>
  );
}
