import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SetupProgress } from "./setup-progress";
import type { MemberSummary } from "@/lib/files/member-service";

const MEMBERS: readonly MemberSummary[] = [
  {
    displayName: "Linh Nguyen",
    email: "linh.np@blended-asia.com",
    sheetId: "12",
    sheetTitle: "Linh Nguyen",
    setupStatus: "ready",
    invitationSent: true,
  },
  {
    displayName: "Anh Tran",
    email: "anh.t@blended-asia.com",
    sheetId: null,
    sheetTitle: null,
    setupStatus: "pending",
    invitationSent: false,
  },
];

const BASE = {
  fileId: "file-1",
  fileName: "202609勤怠管理表",
  folderName: "Attendance / 2026",
  description: "The file was created and kept in Google Drive.",
  members: MEMBERS,
} as const;

describe("SetupProgress", () => {
  it("shows what Drive kept and offers Resume, because nothing is ever rolled back", () => {
    render(<SetupProgress {...BASE} />);

    expect(screen.getByRole("heading", { name: "Setup did not finish" })).toBeVisible();
    expect(screen.getByText("202609勤怠管理表")).toBeVisible();
    expect(screen.getByText("Attendance / 2026")).toBeVisible();
    expect(screen.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
      "href",
      "/files/file-1/setup",
    );
    expect(screen.getByLabelText("Linh Nguyen")).toBeInTheDocument();
    expect(screen.getByLabelText("Anh Tran")).toBeInTheDocument();
  });

  it("announces what happened politely instead of taking focus", () => {
    const { container } = render(<SetupProgress {...BASE} />);

    const status = container.querySelector(".wizard-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("The file was created and kept in Google Drive.");
    expect(document.activeElement).toBe(document.body);
  });

  it("offers a retry only when the flow can safely re-run against the retained file", () => {
    const onRetry = vi.fn();

    const { rerender } = render(<SetupProgress {...BASE} />);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();

    rerender(<SetupProgress {...BASE} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<SetupProgress {...BASE} onRetry={onRetry} isRetrying />);
    expect(screen.getByRole("button", { name: "Retrying setup…" })).toBeDisabled();
  });
});
