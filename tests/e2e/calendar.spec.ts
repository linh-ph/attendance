import { expect, test, type Page } from "@playwright/test";
import { EMPLOYEE_STORAGE_STATE, resetStore } from "../../playwright.config";

/**
 * The calendar is drawn from the month, never from the data.
 *
 * `attendance.spec.ts` covers the loaded month, its preview, and the editor.
 * This file covers the opposite case, which is the one that used to render
 * nothing at all: a month with no timesheet behind it.
 *
 * The fixture's files never cover the real current month, so arriving at the
 * dashboard lands on an empty month every time this runs.
 */

test.use({ storageState: EMPLOYEE_STORAGE_STATE });

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
});

const monthGrid = (page: Page) => page.getByRole("grid", { name: /attendance calendar$/ });

test("draws a full month grid when no timesheet covers it", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();

  const grid = monthGrid(page);
  await expect(grid).toBeVisible();

  // Seven weekday columns, and complete weeks — so at least four rows of seven.
  await expect(grid.getByRole("columnheader")).toHaveCount(7);
  const cells = await grid.getByRole("gridcell").count();
  expect(cells).toBeGreaterThanOrEqual(28);
  expect(cells % 7).toBe(0);

  // The absence of data is a sentence underneath, not a missing calendar.
  await expect(page.getByText("No timesheet for this month")).toBeVisible();
});

test("steps between months without needing data for either", async ({ page }) => {
  await page.goto("/dashboard");

  const before = await monthGrid(page).getAttribute("aria-label");

  await page.getByRole("button", { name: "Next month" }).click();
  await expect(monthGrid(page)).not.toHaveAttribute("aria-label", before ?? "");
  await expect(monthGrid(page)).toBeVisible();

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(monthGrid(page)).toHaveAttribute("aria-label", before ?? "");
});

test("offers a jump to the month that does hold a timesheet", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("No timesheet for this month")).toBeVisible();

  await page
    .getByRole("button", { name: /^Go to .*2026$/ })
    .first()
    .click();

  await expect(page.getByRole("grid", { name: "July 2026 attendance calendar" })).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: /Wednesday, July 1, 2026/ }),
  ).toBeVisible();
});

test("Sync sheet re-reads the month and keeps the calendar on screen", async ({ page }) => {
  await page.goto("/dashboard");
  await page
    .getByRole("button", { name: /^Go to .*2026$/ })
    .first()
    .click();

  // Three fixture files cover July, so a file still has to be chosen. The tab
  // does not: this file's member table names this person, so the button
  // already carries their tab title.
  await page
    .getByRole("button", { name: /^Use 202607勤怠管理表 — Employee A/ })
    .first()
    .click();

  const grid = page.getByRole("grid", { name: "July 2026 attendance calendar" });
  await expect(grid).toBeVisible();
  await expect(page.getByText(/Calendar refreshed/i)).toBeVisible();

  await page.getByRole("button", { name: "Sync sheet" }).click();

  // The grid never disappears while the sync runs, and the month comes back.
  await expect(grid).toBeVisible();
  await expect(page.getByText(/Calendar refreshed/i)).toBeVisible();
});

test("keeps the month after a reload, from this browser's own copy", async ({ page }) => {
  await page.goto("/dashboard");
  await page
    .getByRole("button", { name: /^Go to .*2026$/ })
    .first()
    .click();

  await expect(
    page.getByRole("gridcell", { name: /Wednesday, July 1, 2026/ }),
  ).toBeVisible();

  await page.reload();

  // The dashboard opens on the current month again, which has no timesheet —
  // but the calendar is still drawn rather than blank.
  await expect(monthGrid(page)).toBeVisible();
});
