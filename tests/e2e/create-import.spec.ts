import { expect, test, type Page } from "@playwright/test";
import {
  E2E_FIXTURE,
  MANAGER_STORAGE_STATE,
  installPickerStub,
  queuePick,
  resetStore,
} from "../../playwright.config";
import { buildAttendanceWorkbookBuffer } from "../fixtures/workbook";

/**
 * The two manager creation paths and the legacy-file gate (design sections 2.4,
 * 4.3, and 5.3).
 *
 * Only the external Google Picker callback is stubbed. Folder revalidation,
 * workbook inspection, conversion, configuration, protection, and invitation
 * all run through the application's own Route Handlers.
 */

test.use({ storageState: MANAGER_STORAGE_STATE });

const FOLDER_PREFERENCE_KEY = `attendance.dashboardFolder:${E2E_FIXTURE.managerEmail}`;

const NEW_FILE_NAME = "202609勤怠管理表";
const NEW_FILE_MONTH = "2026-09";
const IMPORT_FILE_NAME = "202610勤怠管理表";
const IMPORT_MONTH = "2026-10";

async function rememberActiveFolder(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [FOLDER_PREFERENCE_KEY, JSON.stringify(E2E_FIXTURE.activeFolder)] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
  await installPickerStub(page);
});

test("the manager creates a monthly file and finds it in the destination folder", async ({
  page,
}) => {
  await page.goto("/files/new");

  await expect(page.getByRole("heading", { name: "Create a monthly file" })).toBeVisible();

  await page.getByLabel("File name").fill(NEW_FILE_NAME);
  await page.getByLabel("Month", { exact: true }).fill(NEW_FILE_MONTH);

  await queuePick(page, E2E_FIXTURE.activeFolder);
  await page.getByRole("button", { name: "Select destination folder" }).click();
  await expect(page.getByText(E2E_FIXTURE.activeFolder.name)).toBeVisible();

  await page.getByRole("button", { name: "Continue to members" }).click();

  await page.getByLabel("Employee name 1").fill("Employee A");
  await page.getByLabel("Employee email 1").fill(E2E_FIXTURE.employeeEmail);
  await page.getByRole("button", { name: "Review" }).click();

  await expect(page.getByRole("heading", { name: "Review and create" })).toBeVisible();
  await expect(page.getByText("September 2026")).toBeVisible();

  await page.getByRole("button", { name: "Create file" }).click();

  // The wizard opens the new file's roster once setup finished cleanly.
  await expect(page.getByRole("heading", { name: "Manage members", level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Employee A" })).toBeVisible();

  // The destination folder became the remembered dashboard folder, and the new
  // file is a direct child of it.
  await page.goto("/dashboard");
  await expect(page.getByRole("listitem", { name: NEW_FILE_NAME })).toBeVisible();
  await expect(
    page.getByRole("listitem", { name: NEW_FILE_NAME }).getByText("Ready"),
  ).toBeVisible();
});

test("the manager imports an in-memory workbook and finds the converted file in the folder", async ({
  page,
}) => {
  const workbook = await buildAttendanceWorkbookBuffer({
    month: IMPORT_MONTH,
    sheetTitles: ["Employee A", "Employee B"],
  });

  await page.goto("/files/import");

  await expect(page.getByRole("heading", { name: "Import an Excel workbook" })).toBeVisible();

  await page.getByLabel("Excel workbook (.xlsx)").setInputFiles({
    name: `${IMPORT_FILE_NAME}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });

  // Inspection is local to the server's parser and touches nothing in Google.
  await expect(page.getByRole("heading", { name: "Recognized sheets" })).toBeVisible();
  const recognized = page.getByRole("list", { name: "Recognized sheets" });
  await expect(recognized.getByRole("listitem", { name: "Employee A" })).toBeVisible();
  await expect(recognized.getByRole("listitem", { name: "Employee B" })).toBeVisible();

  // The month is suggested from the workbook's own date rows, never its name.
  await expect(page.getByLabel("Month", { exact: true })).toHaveValue(IMPORT_MONTH);
  await expect(page.getByLabel("Output file name")).toHaveValue(IMPORT_FILE_NAME);

  await queuePick(page, E2E_FIXTURE.activeFolder);
  await page.getByRole("button", { name: "Select destination folder" }).click();
  await expect(page.getByText(E2E_FIXTURE.activeFolder.name)).toBeVisible();

  await page.getByLabel("Email for Employee A").fill(E2E_FIXTURE.employeeEmail);
  await page.getByLabel("Email for Employee B").fill(E2E_FIXTURE.teammateEmail);

  await page.getByRole("button", { name: "Save to Google Drive" }).click();

  await expect(page.getByRole("heading", { name: "Manage members", level: 1 })).toBeVisible();

  await page.goto("/dashboard");
  await expect(page.getByRole("listitem", { name: IMPORT_FILE_NAME })).toBeVisible();
});

test("a partial import keeps the converted file and retries setup on that same file", async ({
  page,
}) => {
  await resetStore(page.request, { inviteFailures: [E2E_FIXTURE.teammateEmail] });

  const workbook = await buildAttendanceWorkbookBuffer({
    month: IMPORT_MONTH,
    sheetTitles: ["Employee A", "Employee B"],
  });

  await page.goto("/files/import");
  await page.getByLabel("Excel workbook (.xlsx)").setInputFiles({
    name: `${IMPORT_FILE_NAME}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });

  await expect(page.getByRole("heading", { name: "Recognized sheets" })).toBeVisible();

  await queuePick(page, E2E_FIXTURE.activeFolder);
  await page.getByRole("button", { name: "Select destination folder" }).click();
  await expect(page.getByText(E2E_FIXTURE.activeFolder.name)).toBeVisible();

  await page.getByLabel("Email for Employee A").fill(E2E_FIXTURE.employeeEmail);
  await page.getByLabel("Email for Employee B").fill(E2E_FIXTURE.teammateEmail);
  await page.getByRole("button", { name: "Save to Google Drive" }).click();

  await expect(page.getByRole("heading", { name: "Setup did not finish" })).toBeVisible();
  await expect(
    page.getByText(
      "The file was converted and kept in Google Drive. Resume setup to finish the remaining steps.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Invitation failed")).toBeVisible();

  // The retry resumes the retained conversion instead of converting again.
  await page.getByRole("button", { name: "Retry setup" }).click();
  await expect(page.getByRole("heading", { name: "Manage members", level: 1 })).toBeVisible();

  await page.goto("/dashboard");
  await expect(page.getByRole("listitem", { name: IMPORT_FILE_NAME })).toHaveCount(1);
});

test("a legacy file stays read-only until the manager picks that same file", async ({ page }) => {
  await rememberActiveFolder(page);
  await page.goto("/dashboard");

  const legacyCard = page.getByRole("listitem", { name: E2E_FIXTURE.legacyFile.name });
  await expect(legacyCard.getByText("Needs setup")).toBeVisible();
  await expect(legacyCard.getByRole("link", { name: "Continue setup" })).toHaveCount(0);

  // Picking a different file proves nothing and unlocks nothing.
  await queuePick(page, { id: E2E_FIXTURE.readyFile.id, name: E2E_FIXTURE.readyFile.name });
  await legacyCard.getByRole("button", { name: "Set up" }).click();
  await expect(
    legacyCard.getByText("Select this same file in Google Picker to start setup."),
  ).toBeVisible();
  await expect(legacyCard.getByRole("link", { name: "Continue setup" })).toHaveCount(0);

  await queuePick(page, { id: E2E_FIXTURE.legacyFile.id, name: E2E_FIXTURE.legacyFile.name });
  await legacyCard.getByRole("button", { name: "Set up" }).click();
  await expect(legacyCard.getByRole("link", { name: "Continue setup" })).toBeVisible();
});

test("legacy setup reads nothing before the Picker confirmation and configures after it", async ({
  page,
}) => {
  await rememberActiveFolder(page);
  await page.goto(`/files/${E2E_FIXTURE.legacyFile.id}/setup`);

  await expect(page.getByRole("heading", { name: "Confirm this file" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Map every sheet to a member" })).toHaveCount(0);

  // The application's own API refuses a mismatched pick before it reads Drive.
  const refused = await page.request.get(
    `/api/files/${E2E_FIXTURE.legacyFile.id}/setup?folderId=${E2E_FIXTURE.activeFolder.id}` +
      `&pickedFileId=${E2E_FIXTURE.readyFile.id}`,
  );
  expect(refused.status()).toBe(403);

  await queuePick(page, { id: E2E_FIXTURE.legacyFile.id, name: E2E_FIXTURE.legacyFile.name });
  await page.getByRole("button", { name: "Select this file in Google Picker" }).click();

  await expect(page.getByRole("heading", { name: "Map every sheet to a member" })).toBeVisible();

  await page.getByLabel("Month", { exact: true }).fill(E2E_FIXTURE.legacyFile.month);
  await page.getByLabel(`Name for ${E2E_FIXTURE.employeeSheetTitle}`).fill("Employee A");
  await page
    .getByLabel(`Google Workspace email for ${E2E_FIXTURE.employeeSheetTitle}`)
    .fill(E2E_FIXTURE.employeeEmail);
  await page.getByLabel(`Name for ${E2E_FIXTURE.teammateSheetTitle}`).fill("Employee B");
  await page
    .getByLabel(`Google Workspace email for ${E2E_FIXTURE.teammateSheetTitle}`)
    .fill(E2E_FIXTURE.teammateEmail);

  await page.getByRole("button", { name: "Save setup" }).click();

  await expect(page.getByText("Setup complete. This file is ready.")).toBeVisible();

  await page.goto("/dashboard");
  await expect(
    page.getByRole("listitem", { name: E2E_FIXTURE.legacyFile.name }).getByText("Ready"),
  ).toBeVisible();
});
