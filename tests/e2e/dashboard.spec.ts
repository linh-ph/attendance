import { expect, test } from "@playwright/test";
import {
  E2E_FIXTURE,
  MANAGER_STORAGE_STATE,
  installPickerStub,
  queuePick,
  resetStore,
} from "../../playwright.config";

/**
 * Manager folder selection and folder-scoped discovery (design sections 2.5
 * and 5.3).
 *
 * The folder is the only thing the browser remembers, and it is never trusted:
 * every assertion here goes through `GET /api/dashboard`, which revalidates the
 * folder with Drive and lists only its direct, owned, correctly named children.
 */

test.use({ storageState: MANAGER_STORAGE_STATE });

const FOLDER_PREFERENCE_KEY = `attendance.dashboardFolder:${E2E_FIXTURE.managerEmail}`;

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
  await installPickerStub(page);
});

test("the manager selects a folder and sees only its direct matching children", async ({ page }) => {
  await page.goto("/manage");

  await expect(
    page.getByText("Choose a folder to see managed attendance files."),
  ).toBeVisible();

  await queuePick(page, E2E_FIXTURE.activeFolder);
  await page.getByRole("button", { name: "Select folder" }).click();

  const managed = page.getByRole("region", { name: "Attendance files" });
  await expect(page.getByRole("region", { name: E2E_FIXTURE.activeFolder.name })).toBeVisible();

  // Present: an owned, directly parented, correctly named file.
  await expect(managed.getByRole("row").filter({ hasText: E2E_FIXTURE.readyFile.name })).toBeVisible();
  await expect(managed.getByRole("row").filter({ hasText: E2E_FIXTURE.legacyFile.name })).toBeVisible();

  // Absent: wrong name, and a file one folder deeper.
  await expect(page.getByText(E2E_FIXTURE.unmarkedFile.name)).toHaveCount(0);
  await expect(page.getByText(E2E_FIXTURE.nestedFile.name)).toHaveCount(0);

  // Absent: a file that lives in the manager's other folder.
  await expect(page.getByText(E2E_FIXTURE.archivedFile.name)).toHaveCount(0);
});

test("changing the folder replaces the listing with that folder's children", async ({ page }) => {
  await page.goto("/manage");

  await queuePick(page, E2E_FIXTURE.activeFolder);
  await page.getByRole("button", { name: "Select folder" }).click();
  await expect(page.getByRole("row").filter({ hasText: E2E_FIXTURE.readyFile.name })).toBeVisible();

  await queuePick(page, E2E_FIXTURE.archiveFolder);
  await page.getByRole("button", { name: "Change folder" }).click();

  await expect(page.getByText(E2E_FIXTURE.archiveFolder.name)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: E2E_FIXTURE.archivedFile.name })).toBeVisible();
  await expect(page.getByText(E2E_FIXTURE.readyFile.name)).toHaveCount(0);
});

test("an invalid remembered folder shows Folder unavailable and never falls back to all of Drive", async ({
  page,
}) => {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [
      FOLDER_PREFERENCE_KEY,
      JSON.stringify({ id: E2E_FIXTURE.missingFolderId, name: "Deleted folder" }),
    ] as const,
  );

  await page.goto("/manage");

  await expect(page.getByRole("heading", { name: "Choose another folder" })).toBeVisible();
  await expect(page.getByText("Folder unavailable.", { exact: true })).toBeVisible();

  // No all-Drive fallback: not one managed file is listed, including the ones
  // this manager owns in the folders that are still valid.
  await expect(page.getByText(E2E_FIXTURE.readyFile.name)).toHaveCount(0);
  await expect(page.getByText(E2E_FIXTURE.archivedFile.name)).toHaveCount(0);
  await expect(
    page.getByText("Choose a folder to see managed attendance files."),
  ).toBeVisible();

  // The unusable folder is forgotten, so a reload does not repeat the failure.
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), FOLDER_PREFERENCE_KEY))
    .toBeNull();
});

test("a manager with no shared timesheet still sees the employee section", async ({ page }) => {
  await page.goto("/timesheets");

  const timesheets = page.getByRole("region", { name: "Your attendance months" });
  await expect(timesheets.getByText("No timesheet for this month")).toBeVisible();
});
