import { expect, test } from "@playwright/test";
import { E2E_FIXTURE, EMPLOYEE_STORAGE_STATE, resetStore } from "../../playwright.config";

/**
 * Employee discovery and the two editing methods (design sections 3, 4.1,
 * and 4.2).
 *
 * Nothing on this path is stubbed except Drive and Sheets themselves. The
 * timesheet the employee opens is the one the discovery rules chose, the sheet
 * ID in the URL is the numeric mapping from the protected configuration, and
 * every save goes through the authorized Route Handler.
 */

test.use({ storageState: EMPLOYEE_STORAGE_STATE });

const TIMESHEET_LABEL = `${E2E_FIXTURE.readyFile.name} — ${E2E_FIXTURE.employeeSheetTitle} — ${E2E_FIXTURE.managerEmail}`;
const ATTENDANCE_URL = `/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.employeeSheetId}`;
const WORK_DESCRIPTION = "Sprint planning";
const NOTES = "Reviewed the July timesheet";

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
});

/**
 * Every attendance file the account can reach is listed, and the one that maps
 * this person opens straight at their tab. The app no longer hides files it
 * has no configuration for: Google's own sharing decides what is reachable,
 * and the person picks their tab when nothing says which is theirs.
 */
test("the employee sees every reachable file and opens the mapped one at their tab", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const timesheets = page.getByRole("region", { name: "My timesheets" });

  await expect(timesheets.getByRole("listitem", { name: TIMESHEET_LABEL })).toBeVisible();
  await expect(timesheets.getByRole("listitem").first()).toBeVisible();

  // An employee never sees a managed section with someone else's files in it.
  await expect(
    page.getByText("Select a dashboard folder to see the attendance files you manage."),
  ).toBeVisible();

  await timesheets.getByRole("link", { name: "Open timesheet" }).first().click();

  await expect(page).toHaveURL(new RegExp(`${ATTENDANCE_URL}$`));
  await expect(page.getByRole("heading", { name: "Timesheet", level: 1 })).toBeVisible();
  await expect(page.getByText("July 2026")).toBeVisible();
  await expect(page.getByText(E2E_FIXTURE.employeeSheetTitle)).toBeVisible();
});

test("a file with no mapping offers a tab choice instead of being hidden", async ({ page }) => {
  await page.goto("/dashboard");

  const timesheets = page.getByRole("region", { name: "My timesheets" });
  const chooser = timesheets.getByRole("link", { name: "Choose your tab" }).first();

  await expect(chooser).toBeVisible();
  await chooser.click();

  await expect(page.getByRole("heading", { name: "Choose your tab", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open this tab" }).first()).toBeVisible();
});

test("the employee edits one day with both methods and saves it to Google Sheets", async ({
  page,
}) => {
  await page.goto(ATTENDANCE_URL);

  await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Choose day/ })).toHaveText(/2026-07-01/);

  await page.getByLabel("Status").selectOption({ label: "Office" });
  await page.getByLabel("Clock in").selectOption("09:00");
  await page.getByLabel("Clock out").selectOption("18:00");

  // The reserved lunch hour owns column G, so the break field goes read-only.
  await page.getByLabel("Lunch break · 12:00–13:00").check();
  await expect(page.getByLabel("Break hours")).toBeDisabled();
  await expect(page.getByLabel("Break hours")).toHaveValue("1");

  await page.getByLabel("Notes").fill(NOTES);

  // Work hours follow the sheet's own `F - G - E`.
  await expect(page.getByRole("status").filter({ hasText: "8 hours" })).toBeVisible();

  // Method one: a work block, expanded by the domain and skipping lunch.
  await page.getByLabel("Start").selectOption("09:00");
  await page.getByLabel("End").selectOption("13:00");
  await page.getByLabel("Work description").fill(WORK_DESCRIPTION);
  await page.getByRole("button", { name: "Apply work block" }).click();

  await expect(page.getByLabel("09:00 work")).toHaveValue(WORK_DESCRIPTION);
  await expect(page.getByLabel("11:30 work")).toHaveValue(WORK_DESCRIPTION);
  await expect(page.getByLabel("12:00 work")).toBeDisabled();
  await expect(page.getByText("Reserved for lunch break").first()).toBeVisible();

  // Method two: one 30-minute slot typed directly into the timeline.
  await page.getByLabel("14:00 work").fill("Customer call");

  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Save to Google Sheets" }).click();

  await expect(page.getByText("Saved to Google Sheets.")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // Reload: the values came back from the sheet, not from browser state.
  await page.reload();

  await expect(page.getByLabel("Notes")).toHaveValue(NOTES);
  await expect(page.getByLabel("Clock in")).toHaveValue("09:00");
  await expect(page.getByLabel("Clock out")).toHaveValue("18:00");
  await expect(page.getByLabel("Status")).toHaveValue("office");
  await expect(page.getByLabel("Lunch break · 12:00–13:00")).toBeChecked();
  await expect(page.getByLabel("09:00 work")).toHaveValue(WORK_DESCRIPTION);
  await expect(page.getByLabel("14:00 work")).toHaveValue("Customer call");
});

test("a failed save keeps the edits and retries in place", async ({ page }) => {
  await resetStore(page.request, { attendanceSaveFailures: 1 });

  await page.goto(ATTENDANCE_URL);
  await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();

  await page.getByLabel("Clock in").selectOption("09:00");
  await page.getByLabel("Clock out").selectOption("17:30");
  await page.getByLabel("Notes").fill(NOTES);

  await page.getByRole("button", { name: "Save to Google Sheets" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "Google Sheets could not be reached. Try again." }),
  ).toBeVisible();

  // Nothing was discarded: the draft is still on screen and still dirty.
  await expect(page.getByLabel("Notes")).toHaveValue(NOTES);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Saved to Google Sheets.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Notes")).toHaveValue(NOTES);
  await expect(page.getByLabel("Clock out")).toHaveValue("17:30");
});

test("an invalid day is refused before it leaves the browser", async ({ page }) => {
  await page.goto(ATTENDANCE_URL);
  await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();

  await page.getByLabel("Clock in").selectOption("18:00");
  await page.getByLabel("Clock out").selectOption("09:00");

  await page.getByRole("button", { name: "Save to Google Sheets" }).click();

  await expect(page.getByText("Clock out must be later than clock in.")).toBeVisible();
  await expect(page.getByText("Saved to Google Sheets.")).toHaveCount(0);
});

test("moving to another day never discards unsaved work silently", async ({ page }) => {
  await page.goto(ATTENDANCE_URL);
  await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();

  await page.getByLabel("Notes").fill(NOTES);

  // Scrolled to the foot of the month, as anyone filling in a timeline is. The
  // day buttons are sticky and stay reachable; the warning they raise is not,
  // so this is the position that once left it off-screen entirely.
  await page.getByRole("button", { name: "Save to Google Sheets" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Next day" }).click();

  const warning = page.getByText("You have unsaved changes on this day.");
  await expect(warning).toBeVisible();
  // `toBeVisible` passes on an element scrolled out of the window, which is
  // exactly how this went unnoticed. The person has to be able to see it.
  await expect(warning).toBeInViewport();
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();

  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("button", { name: /^Choose day/ })).toHaveText(/2026-07-01/);
  await expect(page.getByLabel("Notes")).toHaveValue(NOTES);
});

/**
 * The IndexedDB adapter itself, which only a real browser can exercise.
 *
 * The unit tests cover the key scoping, the recent-list rules, and the
 * baseline guard against a fake store; what they cannot prove is that the real
 * `attendance-local` database opens, writes, and reads back. That is what this
 * spec is for.
 */
test("unsaved work survives a full page reload", async ({ page }) => {
  await page.goto(ATTENDANCE_URL);

  await expect(page.getByRole("button", { name: /^Choose day/ })).toHaveText(/2026-07-01/);
  await page.getByLabel("Notes").fill(NOTES);

  // Wait for the draft to reach IndexedDB before throwing the page away.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open("attendance-local");
            open.onsuccess = () => {
              const db = open.result;
              const count = db.transaction("drafts", "readonly").objectStore("drafts").count();
              count.onsuccess = () => resolve(count.result);
              count.onerror = () => resolve(-1);
            };
            open.onerror = () => resolve(-1);
          }),
      ),
    )
    .toBeGreaterThan(0);

  await page.reload();

  await expect(page.getByRole("button", { name: /^Choose day/ })).toHaveText(/2026-07-01/);
  await expect(page.getByLabel("Notes")).toHaveValue(NOTES);
});
