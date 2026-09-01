import { LoginPanel } from "@/components/login-panel";
import { SignInButton } from "@/components/sign-in-button";
import { SupabaseSignInButton } from "@/components/supabase-sign-in-button";
import { resolveAuthProvider } from "@/lib/auth/provider";

/**
 * A returning person who was bounced back from `/auth/callback`.
 *
 * The reasons are named rather than collapsed into one message because they
 * need different actions: a declined consent is theirs to retry, a missing
 * refresh token or an unreachable credential store is an operator's to fix, and
 * telling one from the other is the difference between a person retrying
 * usefully and retrying forever.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  "access_denied": "Sign-in was cancelled. Grant access to continue.",
  "no-code": "Google did not complete the sign-in. Try again.",
  "exchange-failed": "That sign-in link has already been used or has expired. Try again.",
  "no-refresh-token":
    "Google did not return a lasting connection. Sign in again and accept the consent screen.",
  "credential-store-unavailable":
    "Signed in, but this app could not store the Google connection. Contact your administrator.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error === undefined ? undefined : (SIGN_IN_ERRORS[error] ?? SIGN_IN_ERRORS["no-code"]);

  return (
    <main className="login-page">
      <LoginPanel
        action={
          <>
            {resolveAuthProvider() === "supabase" ? <SupabaseSignInButton /> : <SignInButton />}
            {message === undefined ? null : (
              <p className="form-error" role="alert">
                {message}
              </p>
            )}
          </>
        }
      />
    </main>
  );
}
