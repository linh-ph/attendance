"use client";

import { useState } from "react";
import { GOOGLE_SCOPES } from "@/auth.config";
import { createClient } from "@/lib/supabase/client";

/**
 * `Continue with Google`, routed through Supabase Auth.
 *
 * Two query parameters are not optional here. `access_type: "offline"` is what
 * makes Google issue a refresh token at all, and `prompt: "consent"` is what
 * makes it issue one *again* for an account that has already granted access —
 * without it a returning person completes sign-in and the callback has nothing
 * to store, so their Drive access expires within the hour.
 *
 * The same scopes as the Auth.js provider, from one definition, so the two
 * paths cannot drift into asking for different access.
 */

export function SupabaseSignInButton() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);

    const { error: failure } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: GOOGLE_SCOPES.join(" "),
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });

    if (failure) {
      setBusy(false);
      setError("Google sign-in could not start. Try again.");
    }
  }

  return (
    <>
      <button className="google-button" type="button" onClick={signIn} disabled={busy}>
        {/* Decorative: the label already names the provider. */}
        <span className="google-button-mark" aria-hidden="true">
          G
        </span>
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
