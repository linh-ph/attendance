import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { folderPreferenceKey } from "@/lib/dashboard/folder-preference";
import { createMemoryStore, type LocalStore } from "@/lib/dashboard/local-store";
import type { MemberSetupProgress } from "@/lib/files/setup-service";
import { NewFileWizard, type CreateFileResponse, type CreateWizardApi } from "./new-file-wizard";

const EMAIL = "manager@blended-asia.com";
const PREFERENCE_KEY = folderPreferenceKey(EMAIL);
const FILE_NAME = "202607勤怠管理表";

/** Mutable Picker result; `vi.hoisted` keeps it reachable from the mock factory. */
const picker = vi.hoisted(() => ({
  folder: { id: "folder-2", name: "Attendance 2027" },
}));

vi.mock("@/components/google-picker", () => ({
  GooglePicker: ({
    mode,
    label,
    onSelect,
  }: {
    mode: "folder" | "spreadsheet";
    label: string;
    onSelect: (item: { id: string; name: string }) => void;
  }) => (
    <button type="button" data-mode={mode} onClick={() => onSelect(picker.folder)}>
      {label}
    </button>
  ),
}));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const REMEMBERED_FOLDER = { id: "folder-1", name: "Attendance 2026" };

function progress(overrides: Partial<MemberSetupProgress> = {}): MemberSetupProgress {
  return {
    displayName: "Employee A",
    email: "employee-a@blended-asia.com",
    sheetId: "101",
    sheetTitle: "Employee A",
    protectionId: "201",
    permissionId: "301",
    setupStatus: "ready",
    error: null,
    ...overrides,
  };
}

function createdResponse(overrides: Partial<CreateFileResponse> = {}): CreateFileResponse {
  return {
    file: {
      id: "new-file",
      name: FILE_NAME,
      month: "2026-07",
      setupState: "ready",
      complete: true,
      ...overrides.file,
    },
    folder: overrides.folder ?? REMEMBERED_FOLDER,
    members: overrides.members ?? [progress()],
  };
}

interface Harness {
  api: CreateWizardApi;
  validateCalls: string[];
  createCalls: Parameters<CreateWizardApi["create"]>[0][];
  navigate: Mock<(href: string) => void>;
}

function createHarness(
  options: {
    onValidateFolder?: (folderId: string) => Promise<{ id: string; name: string }>;
    onCreate?: () => Promise<CreateFileResponse>;
  } = {},
): Harness {
  const validateCalls: string[] = [];
  const createCalls: Harness["createCalls"] = [];

  return {
    validateCalls,
    createCalls,
    navigate: vi.fn<(href: string) => void>(),
    api: {
      async validateFolder(folderId) {
        validateCalls.push(folderId);
        if (options.onValidateFolder) return options.onValidateFolder(folderId);
        return folderId === REMEMBERED_FOLDER.id ? REMEMBERED_FOLDER : picker.folder;
      },
      async create(input) {
        createCalls.push(input);
        return (options.onCreate ?? (async () => createdResponse()))();
      },
    },
  };
}

function renderWizard(harness: Harness = createHarness()) {
  render(<NewFileWizard email={EMAIL} api={harness.api} navigate={harness.navigate} />);
  return harness;
}

function rememberFolder(): void {
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(REMEMBERED_FOLDER));
}

function storedFolder(): unknown {
  const raw = window.localStorage.getItem(PREFERENCE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function typeDetails(fileName = FILE_NAME, month = "2026-07"): void {
  fireEvent.change(screen.getByLabelText("File name"), { target: { value: fileName } });
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: month } });
}

function typeMember(index: number, displayName: string, email: string): void {
  fireEvent.change(screen.getByLabelText(`Employee name ${index}`), {
    target: { value: displayName },
  });
  fireEvent.change(screen.getByLabelText(`Employee email ${index}`), {
    target: { value: email },
  });
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Walks a valid wizard from a remembered folder to the review stage. */
async function reachReview(harness: Harness = createHarness()): Promise<Harness> {
  rememberFolder();
  renderWizard(harness);
  await screen.findByText(REMEMBERED_FOLDER.name);

  typeDetails();
  click("Continue to members");
  typeMember(1, "Employee A", "employee-a@blended-asia.com");
  click("Review");
  await screen.findByRole("heading", { name: "Review and create" });

  return harness;
}

beforeEach(() => {
  window.localStorage.clear();
  picker.folder = { id: "folder-2", name: "Attendance 2027" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Stage order and destination folder                                          */
/* -------------------------------------------------------------------------- */

describe("NewFileWizard — stages", () => {
  it("starts on file details and hides the later stages", async () => {
    rememberFolder();
    renderWizard();

    expect(await screen.findByRole("heading", { name: "File details" })).toBeVisible();
    expect(screen.getByLabelText("File name")).toBeVisible();
    expect(screen.getByLabelText("Month")).toBeVisible();
    expect(screen.queryByLabelText("Employee name 1")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });

  it("moves through file details, members, then review", async () => {
    await reachReview();

    expect(screen.getByRole("heading", { name: "Review and create" })).toBeVisible();
    expect(screen.queryByLabelText("File name")).toBeNull();
  });

  it("keeps every value when going back", async () => {
    await reachReview();

    click("Back to members");
    expect(screen.getByLabelText("Employee name 1")).toHaveValue("Employee A");

    click("Back to file details");
    expect(screen.getByLabelText("File name")).toHaveValue(FILE_NAME);
    expect(screen.getByLabelText("Month")).toHaveValue("2026-07");
  });

  it("defaults the destination to the remembered folder after the server revalidates it", async () => {
    rememberFolder();
    const harness = renderWizard();

    expect(await screen.findByText(REMEMBERED_FOLDER.name)).toBeVisible();
    expect(harness.validateCalls).toEqual([REMEMBERED_FOLDER.id]);
    expect(screen.getByRole("button", { name: "Change folder" })).toBeVisible();
  });

  it("asks for a destination when nothing is remembered", async () => {
    const harness = renderWizard();

    expect(
      await screen.findByRole("button", { name: "Select destination folder" }),
    ).toBeVisible();
    expect(harness.validateCalls).toEqual([]);
  });

  it("revalidates a folder chosen in Google Picker", async () => {
    rememberFolder();
    const harness = renderWizard();

    fireEvent.click(await screen.findByRole("button", { name: "Change folder" }));

    expect(await screen.findByText("Attendance 2027")).toBeVisible();
    expect(harness.validateCalls).toEqual([REMEMBERED_FOLDER.id, "folder-2"]);
  });

  it("refuses to continue while the destination folder is unavailable", async () => {
    const harness = createHarness({
      onValidateFolder: async () => {
        throw Object.assign(new Error("Folder unavailable."), {
          failure: { status: 400, message: "Folder unavailable." },
        });
      },
    });
    rememberFolder();
    renderWizard(harness);

    expect(await screen.findByText("Folder unavailable.")).toBeVisible();

    typeDetails();
    click("Continue to members");

    expect(screen.getByText("Select a destination folder.")).toBeVisible();
    expect(screen.queryByLabelText("Employee name 1")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Client validation                                                           */
/* -------------------------------------------------------------------------- */

describe("NewFileWizard — file details validation", () => {
  beforeEach(() => {
    rememberFolder();
  });

  it("requires a file name", async () => {
    renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);

    typeDetails("", "2026-07");
    click("Continue to members");

    expect(screen.getByText("Enter a file name.")).toBeVisible();
    expect(screen.queryByLabelText("Employee name 1")).toBeNull();
  });

  it("requires the 勤怠管理表 marker in the file name", async () => {
    renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);

    typeDetails("July attendance", "2026-07");
    click("Continue to members");

    expect(screen.getByText("The file name must contain 勤怠管理表.")).toBeVisible();
    expect(screen.queryByLabelText("Employee name 1")).toBeNull();
  });

  it("requires a valid month", async () => {
    renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);

    typeDetails(FILE_NAME, "2026-13");
    click("Continue to members");

    expect(screen.getByText("Select the attendance month.")).toBeVisible();
    expect(screen.queryByLabelText("Employee name 1")).toBeNull();
  });
});

describe("NewFileWizard — the creator's own tab", () => {
  /*
   * Whoever creates the file records hours in it too. Until now they had to
   * type themselves in, and a file created without that step simply had no tab
   * for its author.
   */
  it("opens the roster with the creator's own address already in it", async () => {
    rememberFolder();
    renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);
    typeDetails();
    click("Continue to members");

    expect(screen.getByLabelText("Employee email 1")).toHaveValue(EMAIL);
    expect(screen.getByLabelText("Employee name 1")).toHaveValue("");
  });

  it("lets a manager who keeps no timesheet remove that row", async () => {
    rememberFolder();
    renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);
    typeDetails();
    click("Continue to members");

    click("Add employee");
    click("Remove employee 1");

    expect(screen.getByLabelText("Employee email 1")).toHaveValue("");
  });
});

describe("NewFileWizard — the browser member roster", () => {
  async function reachMembersWith(store: LocalStore): Promise<void> {
    rememberFolder();
    const harness = createHarness();
    render(
      <NewFileWizard
        email={EMAIL}
        api={harness.api}
        navigate={harness.navigate}
        store={store}
      />,
    );
    await screen.findByText(REMEMBERED_FOLDER.name);
    typeDetails();
    click("Continue to members");
  }

  async function rosterOf(members: { email: string; displayName: string }[]): Promise<LocalStore> {
    const store = createMemoryStore();
    for (const member of members) await store.addMember(EMAIL, member);
    return store;
  }

  /*
   * Row one belongs to the person creating the file — it opens carrying their
   * own address — so a colleague chosen from the roster lands in a row of their
   * own rather than overwriting the author.
   */
  it("adds a roster member after the creator's own row", async () => {
    await reachMembersWith(
      await rosterOf([{ email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" }]),
    );

    expect(screen.getByLabelText("Employee email 1")).toHaveValue(EMAIL);

    await screen.findByRole("button", { name: "THAI GIA HAN · han.tg@blended-asia.com" });
    click("THAI GIA HAN · han.tg@blended-asia.com");

    expect(screen.getByLabelText("Employee email 1")).toHaveValue(EMAIL);
    expect(screen.getByLabelText("Employee name 2")).toHaveValue("THAI GIA HAN");
    expect(screen.getByLabelText("Employee email 2")).toHaveValue("han.tg@blended-asia.com");
  });

  it("stops offering somebody once they are on the draft", async () => {
    await reachMembersWith(
      await rosterOf([
        { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" },
        { email: "hieu.ntn@blended-asia.com", displayName: "NGUYEN THI NHU HIEU" },
      ]),
    );

    await screen.findByRole("button", { name: "THAI GIA HAN · han.tg@blended-asia.com" });
    click("THAI GIA HAN · han.tg@blended-asia.com");

    expect(
      screen.queryByRole("button", { name: "THAI GIA HAN · han.tg@blended-asia.com" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "NGUYEN THI NHU HIEU · hieu.ntn@blended-asia.com" }),
    ).toBeVisible();
  });

  it("adds a second person to a new row, leaving the first alone", async () => {
    await reachMembersWith(
      await rosterOf([
        { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" },
        { email: "hieu.ntn@blended-asia.com", displayName: "NGUYEN THI NHU HIEU" },
      ]),
    );

    await screen.findByRole("button", { name: "THAI GIA HAN · han.tg@blended-asia.com" });
    click("THAI GIA HAN · han.tg@blended-asia.com");
    click("NGUYEN THI NHU HIEU · hieu.ntn@blended-asia.com");

    expect(screen.getByLabelText("Employee name 2")).toHaveValue("THAI GIA HAN");
    expect(screen.getByLabelText("Employee name 3")).toHaveValue("NGUYEN THI NHU HIEU");
  });

  it("shows no shortcut shelf at all when the roster is empty", async () => {
    await reachMembersWith(createMemoryStore());

    await screen.findByLabelText("Employee name 1");
    expect(screen.queryByText("Add from your members")).toBeNull();
  });
});

describe("NewFileWizard — member validation", () => {
  async function reachMembers(): Promise<Harness> {
    rememberFolder();
    const harness = renderWizard();
    await screen.findByText(REMEMBERED_FOLDER.name);
    typeDetails();
    click("Continue to members");
    return harness;
  }

  it("adds and removes member rows before the file exists", async () => {
    await reachMembers();

    click("Add employee");
    expect(screen.getByLabelText("Employee name 2")).toBeVisible();

    click("Remove employee 2");
    expect(screen.queryByLabelText("Employee name 2")).toBeNull();
  });

  it("refuses an empty roster", async () => {
    await reachMembers();

    click("Remove employee 1");
    click("Review");

    expect(screen.getByText("Add at least one member.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });

  it("requires a name and a valid email on every row", async () => {
    await reachMembers();

    typeMember(1, "", "not-an-email");
    click("Review");

    expect(screen.getByText("Enter the member's name.")).toBeVisible();
    expect(screen.getByText("Enter a valid Google Workspace email address.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });

  it("refuses two members whose normalized emails are the same", async () => {
    await reachMembers();

    typeMember(1, "Employee A", "Employee-A@blended-asia.com");
    click("Add employee");
    typeMember(2, "Employee B", "employee-a@BLENDED-ASIA.com");
    click("Review");

    expect(screen.getByText("Each member needs a different email address.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });

  it("refuses two members whose tab names collide", async () => {
    await reachMembers();

    typeMember(1, "Employee A", "employee-a@blended-asia.com");
    click("Add employee");
    typeMember(2, "employee a", "employee-b@blended-asia.com");
    click("Review");

    expect(
      screen.getByText('Employee sheet title "employee a" is already used by another member.'),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });

  it("refuses an illegal tab-title character", async () => {
    await reachMembers();

    typeMember(1, "Employee:A", "employee-a@blended-asia.com");
    click("Review");

    expect(screen.getByText('An employee sheet title cannot contain ":".')).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and create" })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Review and create                                                           */
/* -------------------------------------------------------------------------- */

describe("NewFileWizard — review and create", () => {
  it("summarizes the request and mutates nothing before Create file", async () => {
    const harness = await reachReview();

    expect(screen.getByText(FILE_NAME)).toBeVisible();
    expect(screen.getByText("July 2026")).toBeVisible();
    expect(screen.getByText(REMEMBERED_FOLDER.name)).toBeVisible();
    expect(screen.getByText("employee-a@blended-asia.com")).toBeVisible();
    expect(harness.createCalls).toEqual([]);
  });

  it("sends trimmed names and normalized emails once", async () => {
    const harness = createHarness();
    rememberFolder();
    renderWizard(harness);
    await screen.findByText(REMEMBERED_FOLDER.name);

    typeDetails(`  ${FILE_NAME}  `);
    click("Continue to members");
    typeMember(1, "  Employee A  ", "  Employee-A@Blended-Asia.com ");
    click("Review");
    await screen.findByRole("heading", { name: "Review and create" });
    click("Create file");

    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0]).toEqual({
      fileName: FILE_NAME,
      month: "2026-07",
      destinationFolder: REMEMBERED_FOLDER,
      members: [{ displayName: "Employee A", email: "employee-a@blended-asia.com" }],
      sendInvitations: true,
    });
  });

  /*
   * The one control on this wizard that reaches anybody but the manager. It is
   * on by default, which is what creating a file did before the choice existed,
   * and clearing it withholds only the email — the file is still shared.
   */
  it("offers the invitation email as a choice, on by default", async () => {
    await reachReview();

    expect(screen.getByLabelText("Email each member that the file is shared")).toBeChecked();
  });

  it("creates without emailing anybody when the choice is cleared", async () => {
    const harness = await reachReview();

    fireEvent.click(screen.getByLabelText("Email each member that the file is shared"));
    click("Create file");

    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0].sendInvitations).toBe(false);
    expect(harness.createCalls[0].members).toHaveLength(1);
  });

  it("disables the create button while the request is in flight", async () => {
    let release: ((response: CreateFileResponse) => void) | undefined;
    const harness = createHarness({
      onCreate: () =>
        new Promise<CreateFileResponse>((resolve) => {
          release = resolve;
        }),
    });
    await reachReview(harness);

    click("Create file");
    const button = screen.getByRole("button", { name: "Creating file…" });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(harness.createCalls).toHaveLength(1);

    release?.(createdResponse());
    await waitFor(() => expect(harness.navigate).toHaveBeenCalled());
  });

  it("remembers the destination folder and opens the new file when setup completes", async () => {
    const harness = await reachReview();

    click("Create file");

    await waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledExactlyOnceWith("/files/new-file/members"),
    );
    expect(storedFolder()).toEqual(REMEMBERED_FOLDER);
  });
});

/* -------------------------------------------------------------------------- */
/* Partial setup and failures                                                  */
/* -------------------------------------------------------------------------- */

describe("NewFileWizard — partial setup", () => {
  const partial = createdResponse({
    file: {
      id: "new-file",
      name: FILE_NAME,
      month: "2026-07",
      setupState: "needs-repair",
      complete: false,
    },
    folder: { id: "folder-2", name: "Attendance 2027" },
    members: [
      progress(),
      progress({
        displayName: "Employee B",
        email: "employee-b@blended-asia.com",
        sheetId: "102",
        sheetTitle: "Employee B",
        permissionId: null,
        setupStatus: "invite-failed",
        error: "Could not share this file with this member.",
      }),
    ],
  });

  it("keeps the retained file, switches the remembered folder, and offers Resume setup", async () => {
    const harness = createHarness({ onCreate: async () => partial });
    await reachReview(harness);

    click("Create file");

    expect(await screen.findByRole("heading", { name: "Setup did not finish" })).toBeVisible();
    expect(screen.getByText(FILE_NAME)).toBeVisible();
    expect(screen.getByText("Attendance 2027")).toBeVisible();
    expect(screen.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
      "href",
      "/files/new-file/setup",
    );
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(storedFolder()).toEqual({ id: "folder-2", name: "Attendance 2027" });
  });

  it("shows the per-member progress that Google retained", async () => {
    await reachReview(createHarness({ onCreate: async () => partial }));

    click("Create file");
    await screen.findByRole("heading", { name: "Setup did not finish" });

    expect(within(screen.getByRole("listitem", { name: "Employee A" })).getByText("Ready")).toBeVisible();
    expect(
      within(screen.getByRole("listitem", { name: "Employee B" })).getByText("Invitation failed"),
    ).toBeVisible();
  });

  it("never presents a retained file as a lost file", async () => {
    await reachReview(createHarness({ onCreate: async () => partial }));

    click("Create file");
    await screen.findByRole("heading", { name: "Setup did not finish" });

    expect(
      screen.getByText(
        "The file was created and kept in Google Drive. Resume setup to finish the remaining steps.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create file" })).toBeNull();
  });
});

describe("NewFileWizard — API failures", () => {
  it("keeps every field and lets the manager try again", async () => {
    const harness = createHarness({
      onCreate: async () => {
        throw Object.assign(new Error("Check the file name, month, folder, and members."), {
          failure: { status: 400, message: "Check the file name, month, folder, and members." },
        });
      },
    });
    await reachReview(harness);

    click("Create file");

    expect(
      await screen.findByText("Check the file name, month, folder, and members."),
    ).toBeVisible();

    click("Back to members");
    expect(screen.getByLabelText("Employee email 1")).toHaveValue("employee-a@blended-asia.com");
  });

  it("offers a way back to Google when the session expired", async () => {
    const harness = createHarness({
      onCreate: async () => {
        throw Object.assign(new Error("Unauthorized"), { failure: { status: 401 } });
      },
    });
    await reachReview(harness);

    click("Create file");

    expect(
      await screen.findByText("Your Google session expired. Sign in again to continue."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("never shows a provider message for a Google boundary failure", async () => {
    const harness = createHarness({
      onCreate: async () => {
        throw Object.assign(new Error("quotaExceeded: rate limit from googleapis"), {
          failure: { status: 502, message: "quotaExceeded: rate limit from googleapis" },
        });
      },
    });
    await reachReview(harness);

    click("Create file");

    expect(await screen.findByText("Could not create the attendance file.")).toBeVisible();
    expect(screen.queryByText(/googleapis/)).toBeNull();
  });
});
