import { LoginPanel } from "@/components/login-panel";
import { SignInButton } from "@/components/sign-in-button";

export default function LoginPage() {
  return (
    <main className="login-page">
      <LoginPanel action={<SignInButton />} />
    </main>
  );
}
