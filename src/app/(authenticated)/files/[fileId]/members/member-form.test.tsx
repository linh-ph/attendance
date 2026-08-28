import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemberForm, type MemberApiClient, type MemberApiError } from "./member-form";
import type { MemberSummary } from "@/lib/files/member-service";

const EMPLOYEE_A = "employee-a@blended-asia.com";
const NEW_MEMBER = "new@blended-asia.com";

function summary(overrides: Partial<MemberSummary> = {}): MemberSummary {
  return {
    displayName: "Linh",
    email: EMPLOYEE_A,
    sheetId: "123",
    sheetTitle: "Linh",
    setupStatus: "ready",
    invitationSent: true,
    ...overrides,
  };
}

interface Harness {
  api: MemberApiClient;
  addCalls: Array<{ fileId: string; displayName: string; email: string }>;
  retryCalls: Array<{ fileId: string; email: string }>;
}

function createApi(options: {
  members?: MemberSummary[];
  onAdd?: () => Promise<{ member: MemberSummary; invitationFailed: boolean }>;
  onRetry?: () => Promise<{ member: MemberSummary; invitationFailed: boolean }>;
} = {}): Harness {
  const addCalls: Harness["addCalls"] = [];
  const retryCalls: Harness["retryCalls"] = [];

  return {
    addCalls,
    retryCalls,
    api: {
      async list(fileId) {
        return { fileId, month: "2026-07", members: options.members ?? [summary()] };
      },
      async add(fileId, input) {
        addCalls.push({ fileId, ...input });
        return (
          options.onAdd ??
          (async () => ({
            member: summary({ displayName: "New Person", email: NEW_MEMBER, sheetId: "200", sheetTitle: "New Person" }),
            invitationFailed: false,
          }))
        )();
      },
      async retryInvitation(fileId, email) {
        retryCalls.push({ fileId, email });
        return (
          options.onRetry ??
          (async () => ({
            member: summary({
              displayName: "New Person",
              email: NEW_MEMBER,
              sheetId: "200",
              sheetTitle: "New Person",
            }),
            invitationFailed: false,
          }))
        )();
      },
    },
  };
}

function typeMember(displayName: string, email: string): void {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: displayName } });
  fireEvent.change(screen.getByLabelText("Google Workspace email"), {
    target: { value: email },
  });
}

describe("MemberForm", () => {
  it("lists current members, their setup status, and a link to each tab", async () => {
    const harness = createApi({
      members: [
        summary(),
        summary({
          displayName: "New Person",
          email: NEW_MEMBER,
          sheetId: "200",
          sheetTitle: "New Person",
          setupStatus: "invite-failed",
          invitationSent: false,
        }),
        summary({
          displayName: "Third Person",
          email: "third@blended-asia.com",
          sheetId: "201",
          sheetTitle: "Third Person",
          setupStatus: "pending",
          invitationSent: false,
        }),
      ],
    });

    render(<MemberForm fileId="file-1" api={harness.api} />);

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(within(rows[0]).getByText("Linh")).toBeVisible();
    expect(within(rows[0]).getByText(EMPLOYEE_A)).toBeVisible();
    expect(within(rows[0]).getByText("Ready")).toBeVisible();
    expect(within(rows[0]).getByRole("link", { name: /open sheet/i })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/file-1/edit#gid=123",
    );

    expect(within(rows[1]).getByText("Invitation failed")).toBeVisible();
    expect(within(rows[2]).getByText("Setting up")).toBeVisible();
  });

  it("offers no member-removal action anywhere", async () => {
    const harness = createApi({
      members: [summary(), summary({ email: NEW_MEMBER, displayName: "New Person", sheetId: "200" })],
    });

    render(<MemberForm fileId="file-1" api={harness.api} />);
    await screen.findAllByRole("listitem");

    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("confirms a successful addition without leaving the page", async () => {
    const harness = createApi();
    render(<MemberForm fileId="file-1" api={harness.api} />);
    await screen.findAllByRole("listitem");

    typeMember("  New Person  ", "  New@Blended-Asia.COM ");
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added New Person. Their sheet is ready.",
    );
    expect(harness.addCalls).toEqual([
      { fileId: "file-1", displayName: "New Person", email: NEW_MEMBER },
    ]);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("New Person")).toBeVisible();

    // The add form is still on the page and cleared for the next member.
    expect(screen.getByRole("button", { name: "Add member" })).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Google Workspace email")).toHaveValue("");
  });

  it("validates the name and the email in English before calling the API", async () => {
    const harness = createApi();
    render(<MemberForm fileId="file-1" api={harness.api} />);
    await screen.findAllByRole("listitem");

    typeMember("   ", "not-an-email");
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(await screen.findByText("Enter the member's name.")).toBeVisible();
    expect(screen.getByText("Enter a valid Google Workspace email address.")).toBeVisible();
    expect(harness.addCalls).toEqual([]);
  });

  it("keeps the typed values and shows an English message when the API rejects the member", async () => {
    const harness = createApi({
      onAdd: async () => {
        const error = new Error("This email is already a member of this file.") as MemberApiError;
        error.code = "member-exists";
        throw error;
      },
    });

    render(<MemberForm fileId="file-1" api={harness.api} />);
    await screen.findAllByRole("listitem");

    typeMember("New Person", NEW_MEMBER);
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(
      await screen.findByText("This email is already a member of this file."),
    ).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("New Person");
    expect(screen.getByLabelText("Google Workspace email")).toHaveValue(NEW_MEMBER);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("retains the new sheet and offers Retry invitation when only the invitation fails", async () => {
    const harness = createApi({
      onAdd: async () => ({
        member: summary({
          displayName: "New Person",
          email: NEW_MEMBER,
          sheetId: "200",
          sheetTitle: "New Person",
          setupStatus: "invite-failed",
          invitationSent: false,
        }),
        invitationFailed: true,
      }),
    });

    render(<MemberForm fileId="file-1" api={harness.api} />);
    await screen.findAllByRole("listitem");

    typeMember("New Person", NEW_MEMBER);
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    const failedRow = await screen.findByRole("listitem", { name: /new person/i });
    expect(within(failedRow).getByText("Invitation failed")).toBeVisible();
    expect(within(failedRow).getByRole("link", { name: /open sheet/i })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/file-1/edit#gid=200",
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added New Person, but the Google Drive invitation failed. Retry the invitation.",
    );

    fireEvent.click(
      within(failedRow).getByRole("button", { name: "Retry invitation for New Person" }),
    );

    await waitFor(() => {
      expect(harness.retryCalls).toEqual([{ fileId: "file-1", email: NEW_MEMBER }]);
    });

    // Only the failed member is retried, and the row settles into Ready.
    const readyRow = await screen.findByRole("listitem", { name: /new person/i });
    expect(within(readyRow).getByText("Ready")).toBeVisible();
    expect(
      within(screen.getByRole("listitem", { name: /linh/i })).queryByRole("button"),
    ).toBeNull();
  });
});
