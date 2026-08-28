import { SignInButton } from "@/components/sign-in-button";

export default function LoginPage() {
  return (
    <main>
      <section className="hero" aria-labelledby="login-title">
        <p className="eyebrow">Google Sheets Attendance</p>
        <h1 id="login-title">Sign in</h1>
        <p>Sign in with your Google Workspace account to manage attendance records.</p>
        <SignInButton />
      </section>
    </main>
  );
}
