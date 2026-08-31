import { signIn } from "@/auth";

/**
 * The one primary action on the unauthenticated surface.
 *
 * The label is `Continue with Google` because spec §8.1 names it: there is no
 * separate password to "sign in" with, so the wording describes handing off to
 * Google rather than authenticating here.
 */
export function SignInButton() {
  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <form action={signInWithGoogle}>
      <button className="google-button" type="submit">
        {/* Decorative: the label already names the provider. */}
        <span className="google-button-mark" aria-hidden="true">
          G
        </span>
        Continue with Google
      </button>
    </form>
  );
}
