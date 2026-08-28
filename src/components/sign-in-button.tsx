import { signIn } from "@/auth";

export function SignInButton() {
  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <form action={signInWithGoogle}>
      <button type="submit">Sign in with Google</button>
    </form>
  );
}
