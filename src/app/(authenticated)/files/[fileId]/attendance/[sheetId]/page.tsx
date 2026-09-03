import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth/current-user";
import { PageShell } from "@/components/app-shell/page-shell";
import { AttendanceEditor } from "./attendance-editor";

export const dynamic = "force-dynamic";

interface AttendancePageProps {
  params: Promise<{ fileId: string; sheetId: string }>;
  searchParams: Promise<{ date?: string }>;
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
export default async function AttendancePage({ params, searchParams }: AttendancePageProps) {
  const email = await currentUserEmail();

  if (!email) {
    redirect("/login");
  }

  const { fileId, sheetId } = await params;
  const { date } = await searchParams;

  return (
    <PageShell
      eyebrow="blended-asia"
      title="Timesheet"
      lede="Record one day clearly, keep a local draft, then sync it to Google Sheets."
    >
      <AttendanceEditor
        fileId={fileId}
        sheetId={sheetId}
        email={email}
        initialDate={date}
      />
    </PageShell>
  );
}
