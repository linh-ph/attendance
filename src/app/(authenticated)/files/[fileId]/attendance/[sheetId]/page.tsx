import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AttendanceEditor } from "./attendance-editor";

export const dynamic = "force-dynamic";

interface AttendancePageProps {
  params: Promise<{ fileId: string; sheetId: string }>;
}

/**
 * Server shell for one member's timesheet.
 *
 * The identity is only checked here so an unauthenticated visitor is sent to
 * sign in. Whether this actor may read or write *this* sheet is decided by
 * `/api/files/[fileId]/attendance/[sheetId]` against live Drive metadata and
 * the protected mapping, on every request — the page renders no attendance
 * value of its own, so an unauthorized route parameter reveals nothing.
 */
export default async function AttendancePage({ params }: AttendancePageProps) {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  const { fileId, sheetId } = await params;

  return (
    <main>
      <section aria-labelledby="attendance-title">
        <p className="eyebrow">Google Sheets Attendance</p>
        <h1 id="attendance-title">Timesheet</h1>
        <AttendanceEditor fileId={fileId} sheetId={sheetId} />
      </section>
    </main>
  );
}
