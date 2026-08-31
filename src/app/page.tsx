import { LoginPanel } from "@/components/login-panel";
import { SignInButton } from "@/components/sign-in-button";

/**
 * The root is the same unauthenticated entry point as `/login`, and renders the
 * same panel rather than a second variation of it. Both paths are public (see
 * `lib/auth/paths.ts`), so two hand-maintained versions would be two things to
 * keep in step for no gain.
 */
export default function Home() {
  return (
    <main className="login-page">
      <LoginPanel action={<SignInButton />} />
    </main>
  );
}
