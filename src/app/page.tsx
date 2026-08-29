import Image from "next/image";
import { SignInButton } from "@/components/sign-in-button";

export default function Home() {
  return (
    <main>
      <section className="hero hero-split" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">blended-asia</p>
          <h1 id="page-title">Attendance</h1>
          <p>
            Keep monthly working hours in the team spreadsheet. Managers create
            and share the month; everyone else fills in their own timesheet.
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
