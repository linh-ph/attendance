import { expect, test, type Page } from "@playwright/test";
import { E2E_FIXTURE, EMPLOYEE_STORAGE_STATE, resetStore } from "../../playwright.config";

/**
 * The dashboard calendar's first load, in a real browser.
 *
 * These cover the three things a unit test cannot prove end to end: that the
 * calendar discovers files by itself, that it says which month it looked for
 * when nothing covers it, and that a month it loaded survives a reload because
 * it was stored in IndexedDB rather than re-fetched.
 *
 * The fixture shapes both paths usefully. Its files never cover the real
 * current month, so the empty path is what runs on arrival; and **three** of
 * them cover 2026-07, so picking that month exercises the rule that the app
 * never guesses between candidates.
 */

test.use({ storageState: EMPLOYEE_STORAGE_STATE });

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
});

const calendar = (page: Page) => page.getByRole("region", { name: "Calendar" });

/** Picks July, then resolves the deliberate ambiguity the fixture creates. */
async function showJulyInCalendar(page: Page): Promise<void> {
  const panel = calendar(page);

  await panel.getByLabel("Load another month").fill(E2E_FIXTURE.readyFile.month);
  await panel.getByRole("button", { name: "Load", exact: true }).click();

  await expect(panel.getByText(/More than one timesheet covers July 2026/)).toBeVisible();

  await panel.getByRole("button", { name: "Show in calendar" }).first().click();
}

test("draws the month even when no timesheet covers it", async ({ page }) => {
  await page.goto("/dashboard");

  const panel = calendar(page);

  // The calendar is a property of the month, so it is drawn first and always.
  const table = panel.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).not.toHaveCount(0);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(7);

  // The absence of data is a sentence underneath, not a missing panel.
  await expect(panel.getByText(/no timesheet covers/i)).toBeVisible();
  await expect(panel.getByRole("link", { name: "Create a monthly file" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Load files" })).toBeEnabled();
});

test("steps between months without needing data for either", async ({ page }) => {
  await page.goto("/dashboard");

  const panel = calendar(page);
  await expect(panel.getByRole("table")).toBeVisible();

  const captionBefore = await panel.getByRole("table").locator("caption").textContent();

  await panel.getByRole("button", { name: "Next month" }).click();

  await expect(panel.getByRole("table")).toBeVisible();
  await expect(panel.getByRole("table").locator("caption")).not.toHaveText(captionBefore ?? "");
});

test("never picks between several timesheets for the same month", async ({ page }) => {
  await page.goto("/dashboard");

  const panel = calendar(page);
  await panel.getByLabel("Load another month").fill(E2E_FIXTURE.readyFile.month);
  await panel.getByRole("button", { name: "Load", exact: true }).click();

  await expect(panel.getByText(/the app will not pick for you/)).toBeVisible();
  // No month is drawn while the choice is open.
  await expect(panel.getByRole("link", { name: "Open timesheet" })).toBeHidden();
});

test("draws each date's state once a timesheet is chosen", async ({ page }) => {
  await page.goto("/dashboard");
  await showJulyInCalendar(page);

  const panel = calendar(page);

  await expect(panel.getByRole("table")).toBeVisible();
  // The full readable date and its state — what a screen reader hears, even
  // though the visible cell shows a bare day number.
  await expect(panel.getByText(/July 1, 2026, (Recorded|Not recorded)/)).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open timesheet" })).toBeVisible();
});

test("keeps the month it loaded after a reload, from this browser's own copy", async ({ page }) => {
  await page.goto("/dashboard");
  await showJulyInCalendar(page);

  // Wait for July's *data*, not merely for a table: the September grid is on
  // screen from the first frame, so asserting a table here would let the reload
  // race the load it is supposed to be testing.
  await expect(calendar(page).getByText(/July 1, 2026, (Recorded|Not recorded)/)).toBeVisible();

  await page.reload();

  // Drawn from IndexedDB on the first frame. The background check then finds
  // nothing for the *current* month, and that must not wipe what is on screen.
  await expect(calendar(page).getByRole("table")).toBeVisible();
  await expect(calendar(page).getByText(/July 1, 2026, (Recorded|Not recorded)/)).toBeVisible();
});
