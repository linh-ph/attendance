import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MEMBER_STATUS_LABELS, MemberRows } from "./member-rows";
import type { MemberSummary } from "@/lib/files/member-service";

const FILE_ID = "file-1";

function summary(overrides: Partial<MemberSummary> = {}): MemberSummary {
  return {
    displayName: "Employee A",
    email: "employee-a@blended-asia.com",
    sheetId: "101",
    sheetTitle: "Employee A",
    setupStatus: "ready",
    invitationSent: true,
    ...overrides,
  };
}

function row(name: string): HTMLElement {
  return screen.getByRole("listitem", { name });
}

describe("MemberRows — roster", () => {
  it("shows the default empty state when the roster is empty", () => {
    render(<MemberRows fileId={FILE_ID} members={[]} />);

    expect(screen.getByText("No members yet.")).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a caller-supplied empty state instead of the default", () => {
    render(<MemberRows fileId={FILE_ID} members={[]} emptyMessage="Nobody here yet." />);

    expect(screen.getByText("Nobody here yet.")).toBeVisible();
    expect(screen.queryByText("No members yet.")).toBeNull();
  });

  it("renders one row per member with name, email, and English status", () => {
    render(
      <MemberRows
        fileId={FILE_ID}
        members={[
          summary(),
          summary({
            displayName: "Employee B",
            email: "employee-b@blended-asia.com",
            sheetId: null,
            sheetTitle: null,
            setupStatus: "pending",
            invitationSent: false,
          }),
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    const first = row("Employee A");
    expect(within(first).getByText("employee-a@blended-asia.com")).toBeVisible();
    expect(within(first).getByText(MEMBER_STATUS_LABELS.ready)).toBeVisible();

    expect(within(row("Employee B")).getByText(MEMBER_STATUS_LABELS.pending)).toBeVisible();
  });

  it("labels every setup status in English", () => {
    expect(MEMBER_STATUS_LABELS).toEqual({
      ready: "Ready",
      pending: "Setting up",
      "invite-failed": "Invitation failed",
    });
  });

  it("links to the member tab only once the sheet exists", () => {
    render(
      <MemberRows
        fileId={FILE_ID}
        members={[summary(), summary({ displayName: "Employee B", email: "b@x.com", sheetId: null })]}
      />,
    );

    expect(within(row("Employee A")).getByRole("link", { name: "Open sheet" })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/file-1/edit#gid=101",
    );
    expect(within(row("Employee B")).queryByRole("link", { name: "Open sheet" })).toBeNull();
  });

  it("never offers a way to remove a member or revoke access", () => {
    render(
      <MemberRows
        fileId={FILE_ID}
        members={[summary({ setupStatus: "invite-failed", invitationSent: false })]}
        onRetryInvitation={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("MemberRows — retry invitation", () => {
  const failed = summary({ setupStatus: "invite-failed", invitationSent: false });

  it("offers retry only for a failed invitation", () => {
    render(
      <MemberRows
        fileId={FILE_ID}
        members={[failed, summary({ displayName: "Employee B", email: "b@x.com" })]}
        onRetryInvitation={vi.fn()}
      />,
    );

    expect(
      within(row("Employee A")).getByRole("button", { name: "Retry invitation for Employee A" }),
    ).toBeVisible();
    expect(within(row("Employee B")).queryByRole("button", { name: /Retry invitation/ })).toBeNull();
  });

  it("offers no action at all without a retry handler", () => {
    render(<MemberRows fileId={FILE_ID} members={[failed]} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports the normalized email of the member being retried", () => {
    const onRetryInvitation = vi.fn();
    render(<MemberRows fileId={FILE_ID} members={[failed]} onRetryInvitation={onRetryInvitation} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry invitation for Employee A" }));

    expect(onRetryInvitation).toHaveBeenCalledExactlyOnceWith("employee-a@blended-asia.com");
  });

  it("disables only the row whose retry is in flight", () => {
    const other = summary({
      displayName: "Employee B",
      email: "employee-b@blended-asia.com",
      setupStatus: "invite-failed",
      invitationSent: false,
    });

    render(
      <MemberRows
        fileId={FILE_ID}
        members={[failed, other]}
        onRetryInvitation={vi.fn()}
        retryingEmail="employee-a@blended-asia.com"
      />,
    );

    expect(screen.getByRole("button", { name: "Retry invitation for Employee A" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry invitation for Employee B" })).toBeEnabled();
  });
});
