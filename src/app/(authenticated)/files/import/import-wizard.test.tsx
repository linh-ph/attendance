import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { folderPreferenceKey } from "@/lib/dashboard/folder-preference";
import {
  ImportWizard,
  importWizardApi,
  type ImportSaveResponse,
  type ImportWizardApi,
  type WorkbookInspectionResult,
} from "./import-wizard";

const EMAIL = "manager@blended-asia.com";
const PREFERENCE_KEY = folderPreferenceKey(EMAIL);
const FILE_NAME = "202607勤怠管理表";

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

const INSPECTION: WorkbookInspectionResult = {
  sheets: [
    { title: "Employee A", rowCount: 31, month: "2026-07" },
    { title: "Employee B", rowCount: 31, month: "2026-07" },
  ],
};

/** The upload name deliberately disagrees with the workbook's real month. */
function workbook(name = "202601勤怠管理表.xlsx"): File {
  return new File(["workbook-bytes"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function savedResponse(overrides: Partial<ImportSaveResponse> = {}): ImportSaveResponse {
  return {
    complete: true,
    fileId: "converted-file",
    folder: REMEMBERED_FOLDER,
    setupState: "ready",
    retryable: false,
    members: [
      { email: "employee-a@blended-asia.com", setupStatus: "ready" },
      { email: "employee-b@blended-asia.com", setupStatus: "ready" },
    ],
    ...overrides,
  };
}

interface Harness {
  api: ImportWizardApi;
  validateCalls: string[];
  inspectCalls: File[];
  saveCalls: Parameters<ImportWizardApi["save"]>[0][];
  navigate: Mock<(href: string) => void>;
}

function createHarness(
  options: {
    onInspect?: () => Promise<WorkbookInspectionResult>;
    onSave?: () => Promise<ImportSaveResponse>;
    onValidateFolder?: (folderId: string) => Promise<{ id: string; name: string }>;
  } = {},
): Harness {
  const validateCalls: string[] = [];
  const inspectCalls: File[] = [];
  const saveCalls: Harness["saveCalls"] = [];

  return {
    validateCalls,
    inspectCalls,
    saveCalls,
    navigate: vi.fn<(href: string) => void>(),
    api: {
      async validateFolder(folderId) {
        validateCalls.push(folderId);
        if (options.onValidateFolder) return options.onValidateFolder(folderId);
        return folderId === REMEMBERED_FOLDER.id ? REMEMBERED_FOLDER : picker.folder;
      },
      async inspect(file) {
        inspectCalls.push(file);
        return (options.onInspect ?? (async () => INSPECTION))();
      },
      async save(input) {
        saveCalls.push(input);
        return (options.onSave ?? (async () => savedResponse()))();
      },
    },
  };
}

function renderWizard(harness: Harness = createHarness()): Harness {
  render(<ImportWizard email={EMAIL} api={harness.api} navigate={harness.navigate} />);
  return harness;
}

function rememberFolder(): void {
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(REMEMBERED_FOLDER));
}

function storedFolder(): unknown {
  const raw = window.localStorage.getItem(PREFERENCE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** jsdom has no DataTransfer, so the selection is defined on the input itself. */
function selectWorkbook(file: File): void {
  const input = screen.getByLabelText("Excel workbook (.xlsx)");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function reviewAndSave(): void {
  click("Continue to review");
  click("Save to Google Drive");
}

function typeEmail(sheetTitle: string, email: string): void {
  fireEvent.change(screen.getByLabelText(`Email for ${sheetTitle}`), {
    target: { value: email },
  });
}

/** Uploads, inspects, and fills in one valid email per detected sheet. */
async function reachConfirmed(harness: Harness = createHarness(), file = workbook()): Promise<Harness> {
  rememberFolder();
  renderWizard(harness);

  selectWorkbook(file);
  await screen.findByRole("heading", { name: "Recognized sheets" });
  click("Continue to details");
  await screen.findByText(REMEMBERED_FOLDER.name);

  typeEmail("Employee A", "employee-a@blended-asia.com");
  typeEmail("Employee B", "employee-b@blended-asia.com");

  return harness;
}

beforeEach(() => {
  window.localStorage.clear();
  picker.folder = { id: "folder-2", name: "Attendance 2027" };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* Upload and inspection                                                       */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — upload", () => {
  it("uses the shared wizard chrome and exposes upload through setup", () => {
    renderWizard();

    expect(screen.getByRole("heading", { level: 1, name: "Import workbook" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Import workbook progress" })).toBeVisible();
    expect(screen.getByText(/Step 1 of 5/u)).toBeVisible();
  });

  it("accepts .xlsx only and documents the size limit", async () => {
    rememberFolder();
    renderWizard();

    const input = await screen.findByLabelText("Excel workbook (.xlsx)");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", ".xlsx");
    expect(screen.getByText("The workbook must be 20 MB or smaller.")).toBeVisible();
  });

  it("inspects the workbook without touching Google", async () => {
    rememberFolder();
    const harness = renderWizard();

    const file = workbook();
    selectWorkbook(file);

    await screen.findByRole("heading", { name: "Recognized sheets" });
    expect(screen.getByText(/Step 2 of 5/u)).toBeVisible();
    expect(screen.queryByLabelText("Output file name")).toBeNull();
    click("Continue to details");
    expect(screen.getByLabelText("Output file name")).toBeVisible();
    await screen.findByText(REMEMBERED_FOLDER.name);
    expect(harness.inspectCalls).toEqual([file]);
    expect(harness.saveCalls).toEqual([]);
  });

  it("shows every recognized sheet before anything is uploaded to Drive", async () => {
    rememberFolder();
    renderWizard();
    selectWorkbook(workbook());

    const sheets = await screen.findByRole("list", { name: "Recognized sheets" });
    expect(within(sheets).getByText("Employee A")).toBeVisible();
    expect(within(sheets).getByText("Employee B")).toBeVisible();
    expect(within(sheets).getAllByText("31 rows · July 2026")).toHaveLength(2);
  });

  it("names the exact sheet and check when the workbook is unsupported", async () => {
    const harness = createHarness({
      onInspect: async () => {
        throw Object.assign(new Error("rejected"), {
          failure: {
            status: 400,
            code: "missing-headers",
            message: "The sheet is missing the required header row.",
            sheetTitle: "Employee B",
          },
        });
      },
    });
    rememberFolder();
    renderWizard(harness);

    selectWorkbook(workbook());

    expect(
      await screen.findByText('Sheet "Employee B": The sheet is missing the required header row.'),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save to Google Drive" })).toBeNull();
    expect(harness.saveCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Confirmed metadata                                                          */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — confirmed metadata", () => {
  it("suggests the upload base name and keeps it editable", async () => {
    await reachConfirmed();

    const nameField = screen.getByLabelText("Output file name");
    expect(nameField).toHaveValue("202601勤怠管理表");

    fireEvent.change(nameField, { target: { value: FILE_NAME } });
    expect(nameField).toHaveValue(FILE_NAME);
  });

  it("requires the 勤怠管理表 marker in the confirmed name", async () => {
    const harness = await reachConfirmed();

    fireEvent.change(screen.getByLabelText("Output file name"), {
      target: { value: "July attendance" },
    });
    click("Continue to review");

    expect(screen.getByText("The file name must contain 勤怠管理表.")).toBeVisible();
    expect(harness.saveCalls).toEqual([]);
  });

  it("takes the month from the workbook and never from the upload name", async () => {
    await reachConfirmed();

    expect(screen.getByLabelText("Month")).toHaveValue("2026-07");
  });

  it("leaves the month empty when the workbook sheets disagree", async () => {
    const harness = createHarness({
      onInspect: async () => ({
        sheets: [
          { title: "Employee A", rowCount: 31, month: "2026-07" },
          { title: "Employee B", rowCount: 30, month: "2026-06" },
        ],
      }),
    });
    rememberFolder();
    renderWizard(harness);

    selectWorkbook(workbook());
    await screen.findByRole("heading", { name: "Recognized sheets" });
    click("Continue to details");
    await screen.findByText(REMEMBERED_FOLDER.name);

    expect(screen.getByLabelText("Month")).toHaveValue("");
  });

  it("defaults the destination to the remembered folder and allows a change", async () => {
    const harness = await reachConfirmed();

    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));

    expect(await screen.findByText("Attendance 2027")).toBeVisible();
    expect(harness.validateCalls).toEqual([REMEMBERED_FOLDER.id, "folder-2"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Sheet mappings                                                              */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — sheet mappings", () => {
  it("requires one email for every detected sheet", async () => {
    const harness = await reachConfirmed();

    fireEvent.change(screen.getByLabelText("Email for Employee B"), { target: { value: "" } });
    click("Continue to review");

    expect(screen.getByText("Enter a valid Google Workspace email address.")).toBeVisible();
    expect(harness.saveCalls).toEqual([]);
  });

  it("refuses the same normalized email on two sheets", async () => {
    const harness = await reachConfirmed();

    typeEmail("Employee B", "Employee-A@Blended-Asia.com");
    click("Continue to review");

    expect(screen.getByText("Each sheet needs a different email address.")).toBeVisible();
    expect(harness.saveCalls).toEqual([]);
  });

  it("fixes each sheet title from the workbook", async () => {
    const harness = await reachConfirmed();

    expect(screen.queryByLabelText("Sheet name 1")).toBeNull();

    reviewAndSave();

    await waitFor(() => expect(harness.saveCalls).toHaveLength(1));
    expect(harness.saveCalls[0].mappings).toEqual([
      { sheetTitle: "Employee A", email: "employee-a@blended-asia.com" },
      { sheetTitle: "Employee B", email: "employee-b@blended-asia.com" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Save                                                                        */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — save", () => {
  it("resubmits the same file object with the confirmed metadata", async () => {
    const file = workbook();
    const harness = await reachConfirmed(createHarness(), file);

    fireEvent.change(screen.getByLabelText("Output file name"), { target: { value: FILE_NAME } });
    reviewAndSave();

    await waitFor(() => expect(harness.saveCalls).toHaveLength(1));
    expect(harness.saveCalls[0]).toEqual({
      file,
      fileName: FILE_NAME,
      month: "2026-07",
      destinationFolder: REMEMBERED_FOLDER,
      mappings: [
        { sheetTitle: "Employee A", email: "employee-a@blended-asia.com" },
        { sheetTitle: "Employee B", email: "employee-b@blended-asia.com" },
      ],
    });
    expect(harness.inspectCalls).toHaveLength(1);
  });

  it("disables the save button while the request is in flight", async () => {
    let release: ((response: ImportSaveResponse) => void) | undefined;
    const harness = await reachConfirmed(
      createHarness({
        onSave: () =>
          new Promise<ImportSaveResponse>((resolve) => {
            release = resolve;
          }),
      }),
    );

    reviewAndSave();
    const button = screen.getByRole("button", { name: "Saving to Google Drive…" });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(harness.saveCalls).toHaveLength(1);

    release?.(savedResponse());
    await waitFor(() => expect(harness.navigate).toHaveBeenCalled());
  });

  it("activates the destination folder and opens the file when setup completes", async () => {
    const harness = await reachConfirmed();

    reviewAndSave();

    await waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledExactlyOnceWith("/files/converted-file/members"),
    );
    expect(storedFolder()).toEqual(REMEMBERED_FOLDER);
  });
});

/* -------------------------------------------------------------------------- */
/* Partial setup                                                               */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — partial setup", () => {
  const partial = savedResponse({
    complete: false,
    folder: { id: "folder-2", name: "Attendance 2027" },
    setupState: "needs-repair",
    retryable: true,
    members: [
      { email: "employee-a@blended-asia.com", setupStatus: "ready" },
      { email: "employee-b@blended-asia.com", setupStatus: "invite-failed" },
    ],
  });

  it("keeps the converted file, activates its folder, and offers Resume setup", async () => {
    const harness = await reachConfirmed(createHarness({ onSave: async () => partial }));

    reviewAndSave();

    expect(await screen.findByRole("heading", { name: "Setup did not finish" })).toBeVisible();
    expect(
      screen.getByText(
        "The file was converted and kept in Google Drive. Resume setup to finish the remaining steps.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
      "href",
      "/files/converted-file/setup",
    );
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(storedFolder()).toEqual({ id: "folder-2", name: "Attendance 2027" });
  });

  it("shows which member setup step Google retained, named by its workbook sheet", async () => {
    await reachConfirmed(createHarness({ onSave: async () => partial }));

    reviewAndSave();
    await screen.findByRole("heading", { name: "Setup did not finish" });

    const failedRow = screen.getByRole("listitem", { name: "Employee B" });
    expect(within(failedRow).getByText("employee-b@blended-asia.com")).toBeVisible();
    expect(within(failedRow).getByText("Invitation failed")).toBeVisible();
    expect(
      within(screen.getByRole("listitem", { name: "Employee A" })).getByText("Ready"),
    ).toBeVisible();
  });

  it("retries against the converted file instead of converting a second one", async () => {
    const file = workbook();
    const harness = await reachConfirmed(createHarness({ onSave: async () => partial }), file);

    reviewAndSave();
    await screen.findByRole("heading", { name: "Setup did not finish" });

    click("Retry setup");

    await waitFor(() => expect(harness.saveCalls).toHaveLength(2));
    expect(harness.saveCalls[1]).toEqual({ ...harness.saveCalls[0], resumeFileId: "converted-file" });
    expect(harness.saveCalls[1].file).toBe(file);
    expect(harness.inspectCalls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe("ImportWizard — API failures", () => {
  it("retains the confirmed fields when the save is rejected", async () => {
    const harness = await reachConfirmed(
      createHarness({
        onSave: async () => {
          throw Object.assign(new Error("rejected"), {
            failure: {
              status: 400,
              code: "duplicate-member-email",
              message: "Duplicate member email.",
            },
          });
        },
      }),
    );

    fireEvent.change(screen.getByLabelText("Output file name"), { target: { value: FILE_NAME } });
    reviewAndSave();

    expect(
      await screen.findByText("Each member must have a different email address."),
    ).toBeVisible();
    click("Back to details");
    expect(screen.getByLabelText("Output file name")).toHaveValue(FILE_NAME);
    expect(screen.getByLabelText("Email for Employee A")).toHaveValue(
      "employee-a@blended-asia.com",
    );
    expect(harness.saveCalls).toHaveLength(1);
  });

  it("offers a way back to Google when the session expired", async () => {
    await reachConfirmed(
      createHarness({
        onSave: async () => {
          throw Object.assign(new Error("Unauthorized"), { failure: { status: 401 } });
        },
      }),
    );

    reviewAndSave();

    expect(
      await screen.findByText("Your Google session expired. Sign in again to continue."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("never shows a provider message for a Google boundary failure", async () => {
    await reachConfirmed(
      createHarness({
        onSave: async () => {
          throw Object.assign(new Error("boom"), {
            failure: { status: 502, message: "backendError from googleapis" },
          });
        },
      }),
    );

    reviewAndSave();

    expect(await screen.findByText("Could not import the attendance file.")).toBeVisible();
    expect(screen.queryByText(/googleapis/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Default browser client                                                      */
/* -------------------------------------------------------------------------- */

describe("importWizardApi", () => {
  const fetchMock = vi.fn();

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  function sentForm(callIndex = 0): FormData {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return init.body as FormData;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("inspects with a multipart body carrying only the workbook", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, INSPECTION));
    const file = workbook();

    await expect(importWizardApi.inspect(file)).resolves.toEqual(INSPECTION);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/files/import/inspect");
    expect(sentForm().get("file")).toBe(file);
    expect(sentForm().get("mappings")).toBeNull();
  });

  it("sends the confirmed metadata as multipart fields and reports 201 as complete", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        fileId: "converted-file",
        folder: REMEMBERED_FOLDER,
        setupState: "ready",
        retryable: false,
        members: [{ email: "employee-a@blended-asia.com", setupStatus: "ready" }],
      }),
    );
    const file = workbook();

    const result = await importWizardApi.save({
      file,
      fileName: FILE_NAME,
      month: "2026-07",
      destinationFolder: REMEMBERED_FOLDER,
      mappings: [{ sheetTitle: "Employee A", email: "employee-a@blended-asia.com" }],
    });

    expect(result.complete).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/files/import");

    const form = sentForm();
    expect(form.get("file")).toBe(file);
    expect(form.get("fileName")).toBe(FILE_NAME);
    expect(form.get("month")).toBe("2026-07");
    expect(JSON.parse(String(form.get("destinationFolder")))).toEqual(REMEMBERED_FOLDER);
    expect(JSON.parse(String(form.get("mappings")))).toEqual([
      { sheetTitle: "Employee A", email: "employee-a@blended-asia.com" },
    ]);
    expect(form.get("resumeFileId")).toBeNull();
  });

  it("reports 207 as an incomplete setup and carries the resume hint back", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(207, {
        fileId: "converted-file",
        folder: REMEMBERED_FOLDER,
        setupState: "needs-repair",
        retryable: true,
        members: [{ email: "employee-a@blended-asia.com", setupStatus: "invite-failed" }],
      }),
    );

    const result = await importWizardApi.save({
      file: workbook(),
      fileName: FILE_NAME,
      month: "2026-07",
      destinationFolder: REMEMBERED_FOLDER,
      mappings: [{ sheetTitle: "Employee A", email: "employee-a@blended-asia.com" }],
      resumeFileId: "converted-file",
    });

    expect(result).toMatchObject({ complete: false, fileId: "converted-file", retryable: true });
    expect(sentForm().get("resumeFileId")).toBe("converted-file");
  });

  it("raises the API failure envelope instead of a bare status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: "The workbook must be 20 MB or smaller.",
        code: "file-too-large",
        sheetTitle: null,
      }),
    );

    await expect(importWizardApi.inspect(workbook())).rejects.toMatchObject({
      failure: {
        status: 400,
        code: "file-too-large",
        message: "The workbook must be 20 MB or smaller.",
      },
    });
  });
});
