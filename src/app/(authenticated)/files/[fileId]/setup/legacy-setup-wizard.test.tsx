import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { folderPreferenceKey } from "@/lib/dashboard/folder-preference";
import {
  LegacySetupWizard,
  type ConfigureExistingRequest,
  type LegacySetupApi,
  type LegacySetupInspection,
  type LegacySetupResult,
} from "./legacy-setup-wizard";

const EMAIL = "manager@blended-asia.com";
const FILE_ID = "legacy-file";
const PREFERENCE_KEY = folderPreferenceKey(EMAIL);

/** Mutable Picker result; `vi.hoisted` keeps it reachable from the mock factory. */
const picker = vi.hoisted(() => ({ spreadsheet: { id: "legacy-file", name: "202607勤怠管理表" } }));

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
    <button type="button" data-mode={mode} onClick={() => onSelect(picker.spreadsheet)}>
      {label}
    </button>
  ),
}));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const FOLDER = { id: "folder-1", name: "Attendance 2026" };

const INSPECTION: LegacySetupInspection = {
  file: { id: FILE_ID, name: "202607勤怠管理表", month: null },
  folder: FOLDER,
  sheets: [
    { sheetId: "11", title: "従業員A" },
    { sheetId: "12", title: "従業員B" },
  ],
  hasUntrustedConfig: true,
  members: [],
};

function memberProgress(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Employee A",
    email: "employee-a@blended-asia.com",
    sheetId: "11",
    sheetTitle: "従業員A",
    protectionId: "2",
    permissionId: "permission-1",
    setupStatus: "ready",
    error: null,
    ...overrides,
  } as LegacySetupResult["members"][number];
}

function completeResult(): LegacySetupResult {
  return {
    file: {
      id: FILE_ID,
      name: "202607勤怠管理表",
      month: "2026-07",
      setupState: "ready",
      complete: true,
    },
    folder: FOLDER,
    members: [memberProgress()],
  };
}

function partialResult(): LegacySetupResult {
  return {
    ...completeResult(),
    file: { ...completeResult().file, setupState: "pending", complete: false },
    members: [
      memberProgress(),
      memberProgress({
        displayName: "Employee B",
        email: "employee-b@blended-asia.com",
        sheetId: "12",
        sheetTitle: "従業員B",
        protectionId: "3",
        permissionId: null,
        setupStatus: "invite-failed",
        error: "Could not share this file with this member.",
      }),
    ],
  };
}

interface FakeApi {
  api: LegacySetupApi;
  inspectCalls: { fileId: string; folderId: string; pickedFileId: string }[];
  configureCalls: ConfigureExistingRequest[];
}

function createFakeApi(
  behavior: {
    inspect?: () => Promise<LegacySetupInspection>;
    configure?: () => Promise<LegacySetupResult>;
  } = {},
): FakeApi {
  const inspectCalls: FakeApi["inspectCalls"] = [];
  const configureCalls: ConfigureExistingRequest[] = [];

  return {
    inspectCalls,
    configureCalls,
    api: {
      async inspect(fileId, input) {
        inspectCalls.push({ fileId, ...input });
        return behavior.inspect ? await behavior.inspect() : INSPECTION;
      },
      async configure(fileId, input) {
        configureCalls.push(input);
        return behavior.configure ? await behavior.configure() : completeResult();
      },
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(FOLDER));
  picker.spreadsheet = { id: FILE_ID, name: "202607勤怠管理表" };
});

async function confirmFile(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: "Select this file in Google Picker" }),
  );
}

async function fillMappings(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-07" } });
  fireEvent.change(screen.getByLabelText("Name for 従業員A"), {
    target: { value: "Employee A" },
  });
  fireEvent.change(screen.getByLabelText("Google Workspace email for 従業員A"), {
    target: { value: "employee-a@blended-asia.com" },
  });
  fireEvent.change(screen.getByLabelText("Name for 従業員B"), {
    target: { value: "Employee B" },
  });
  fireEvent.change(screen.getByLabelText("Google Workspace email for 従業員B"), {
    target: { value: "employee-b@blended-asia.com" },
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("LegacySetupWizard — picker proof", () => {
  it("uses the shared wizard chrome for confirm through setup", async () => {
    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={createFakeApi().api} />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Set up attendance file" }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Set up attendance file progress" }),
    ).toBeVisible();
    expect(screen.getByText(/Step 1 of 4/u)).toBeVisible();
  });

  it("reads nothing from the file before the picker confirms it", async () => {
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);

    expect(
      await screen.findByRole("button", { name: "Select this file in Google Picker" }),
    ).toBeVisible();
    expect(fake.inspectCalls).toEqual([]);
    expect(fake.configureCalls).toEqual([]);
  });

  it("refuses a picker selection that is not this file", async () => {
    const fake = createFakeApi();
    picker.spreadsheet = { id: "another-file", name: "Another workbook" };

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Select this same file in Google Picker to start setup.",
    );
    expect(fake.inspectCalls).toEqual([]);
  });

  it("asks for a dashboard folder when none is remembered", async () => {
    window.localStorage.clear();
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Select your dashboard folder on the dashboard before setting up this file.",
    );
    expect(
      screen.queryByRole("button", { name: "Select this file in Google Picker" }),
    ).toBeNull();
    expect(fake.inspectCalls).toEqual([]);
  });

  it("loads the employee sheets once the same file is confirmed", async () => {
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();

    expect(await screen.findByLabelText("Name for 従業員A")).toBeVisible();
    expect(screen.getByLabelText("Google Workspace email for 従業員B")).toBeVisible();
    expect(fake.inspectCalls).toEqual([
      { fileId: FILE_ID, folderId: FOLDER.id, pickedFileId: FILE_ID },
    ]);
    expect(
      screen.getByText(
        "This file already has a configuration sheet. Setup replaces it with the current one.",
      ),
    ).toBeVisible();
  });
});

describe("LegacySetupWizard — mapping", () => {
  it("refuses two sheets mapped to the same member before sending anything", async () => {
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();
    await screen.findByLabelText("Name for 従業員A");

    await fillMappings();
    fireEvent.change(screen.getByLabelText("Google Workspace email for 従業員B"), {
      target: { value: "employee-a@blended-asia.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Assign each sheet to a different member.",
    );
    expect(fake.configureCalls).toEqual([]);
  });

  it("refuses an incomplete mapping before sending anything", async () => {
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();
    await screen.findByLabelText("Name for 従業員A");

    await fillMappings();
    fireEvent.change(screen.getByLabelText("Google Workspace email for 従業員B"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(fake.configureCalls).toEqual([]);
  });

  it("sends the picked file, the folder, the month, and one mapping per sheet", async () => {
    const fake = createFakeApi();

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();
    await screen.findByLabelText("Name for 従業員A");

    await fillMappings();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));

    expect(screen.getByText(/Step 3 of 4/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Review setup" })).toBeVisible();
    expect(fake.configureCalls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));

    await waitFor(() => expect(fake.configureCalls).toHaveLength(1));
    expect(fake.configureCalls[0]).toEqual({
      pickedFileId: FILE_ID,
      folderId: FOLDER.id,
      month: "2026-07",
      mappings: [
        { sheetId: "11", displayName: "Employee A", email: "employee-a@blended-asia.com" },
        { sheetId: "12", displayName: "Employee B", email: "employee-b@blended-asia.com" },
      ],
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Setup complete. This file is ready.",
    );
  });
});

describe("LegacySetupWizard — partial failure", () => {
  it("keeps the retained progress and offers a resume that repeats the request", async () => {
    const fake = createFakeApi({ configure: async () => partialResult() });

    render(<LegacySetupWizard fileId={FILE_ID} email={EMAIL} api={fake.api} />);
    await confirmFile();
    await screen.findByLabelText("Name for 従業員A");

    await fillMappings();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Setup is incomplete. Retry setup to finish sharing this file.",
    );
    expect(screen.getByText("Invitation failed")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));

    await waitFor(() => expect(fake.configureCalls).toHaveLength(2));
    expect(fake.configureCalls[1]).toEqual(fake.configureCalls[0]);
  });
});
