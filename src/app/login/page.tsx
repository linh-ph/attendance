import Image from "next/image";
import { SignInButton } from "@/components/sign-in-button";

export default function LoginPage() {
  return (
    <main className="page-centered">
      <section className="hero hero-split" aria-labelledby="login-title">
        <div className="hero-copy">
          <p className="eyebrow">blended-asia</p>
          <h1 id="login-title">Attendance</h1>
          <p>
            Record your clock-in and clock-out times, breaks, and daily notes.
            Sign in with your Google Workspace account to open your timesheet.
          </p>
          <SignInButton />
        </div>

        {/* Decorative: empty alt keeps it out of the accessibility tree. */}
        <Image
          className="hero-art"
          src="/meme.jpeg"
          alt=""
          width={387}
          height={516}
          priority
        />
      </section>
    </main>
  );
}
