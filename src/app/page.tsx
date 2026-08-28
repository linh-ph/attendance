export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Attendance, in your workspace</p>
        <h1 id="page-title">Google Sheets Attendance</h1>
        <p>
          Manage monthly attendance records in Google Sheets with the people who
          already work there.
        </p>
        <button type="button" disabled>
          Sign in with Google
        </button>
      </section>
    </main>
  );
}
