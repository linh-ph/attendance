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

const ATTENDANCE_URL = `/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.employeeSheetId}`;
const WORK_DESCRIPTION = "Sprint planning";
const NOTES = "Reviewed the July timesheet";
const CALENDAR_DATE = "2026-07-01";

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
});

/**
 * Every attendance file the account can reach is listed, and the one that maps
 * this person opens straight at their tab. The app no longer hides files it
 * has no configuration for: Google's own sharing decides what is reachable,
 * and the person picks their tab when nothing says which is theirs.
 */
/**
 * A file whose `__APP_CONFIG!H1:N` names this person opens straight into their
 * own tab. The next test proves the other half: a file that maps nobody still
 * offers its tab list. Both matter, because the mapping is a convenience
 * layered over the chooser and never a replacement for it.
 */
test("the employee opens a mapped file straight into their own tab", async ({ page }) => {
  await page.goto("/timesheets");

  const timesheets = page.getByRole("region", { name: "Your attendance months" });
  const readyTimesheet = timesheets
    .getByRole("listitem")
    .filter({ hasText: E2E_FIXTURE.managerEmail });

  await expect(readyTimesheet).toBeVisible();
  await expect(timesheets.getByRole("listitem").first()).toBeVisible();

  // The employee surface stays focused on authorized timesheets; management
  // data lives on its own route instead of being mixed into this page.
  await expect(page.getByRole("heading", { name: "Attendance files" })).toHaveCount(0);

  // The member row carries this actor's email, so there is nothing to pick.
  await readyTimesheet.getByRole("link", { name: "Open timesheet" }).click();

  /*
   * The URL is asserted first, and it names the mapped sheet id — that is the
   * actual claim of this test, and nothing weaker proves it.
   *
   * `exact` is not decoration either: Playwright matches an accessible name by
   * substring by default, so a bare `name: "Timesheet"` also matches the
   * `Timesheets` heading on the list page. That made the old assertion pass
   * before navigation had happened, which is why the following line then
   * matched three months at once.
   */
  await expect(page).toHaveURL(
    new RegExp(`/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.employeeSheetId}$`),
  );
  await expect(page.getByRole("heading", { name: "Timesheet", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("July 2026")).toBeVisible();
});

test("a file with no mapping offers a tab choice instead of being hidden", async ({ page }) => {
  await page.goto("/timesheets");

  const timesheets = page.getByRole("region", { name: "Your attendance months" });
  const chooser = timesheets.getByRole("link", { name: "Choose your tab" }).first();

  await expect(chooser).toBeVisible();
  await chooser.click();

  await expect(page.getByRole("heading", { name: "Choose your tab", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open this tab" }).first()).toBeVisible();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`the ${viewport.name} calendar opens a preview, edits the day, and syncs it`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");

    await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();

    /*
     * The arrows now step one month at a time, as a calendar's do, so the jump
     * to the month that actually holds a timesheet is its own action on the
     * empty-month notice.
     */
    await page
      .getByRole("button", { name: /^Go to .*2026$/ })
      .first()
      .click();

    /*
     * Three fixture files cover July, so the app still refuses to guess which
     * FILE — that is a genuine ambiguity no configuration resolves. The tab
     * inside it is different: this file's member table names this person, so
     * the button already carries their tab title and no second step follows.
     */
    const choice = page.getByRole("button", {
      name: `Use ${E2E_FIXTURE.readyFile.name} — ${E2E_FIXTURE.employeeSheetTitle} — ${E2E_FIXTURE.managerEmail}`,
    });
    await expect(choice).toBeVisible();
    await choice.click();

    await expect(page.getByRole("heading", { name: "Which tab is yours?" })).toHaveCount(0);

    const calendar = page.getByRole("grid", { name: "July 2026 attendance calendar" });
    await expect(calendar).toBeVisible();
    /*
     * Named by its record state, not by the date alone. The grid is drawn from
     * the month before any data arrives, so a bare-date locator would match the
     * inert `No timesheet data` cell and click it before the month lands.
     */
    await calendar
      .getByRole("gridcell", { name: /Wednesday, July 1, 2026 — (Recorded|Not recorded)/ })
      .click();

    const preview = page.getByRole("dialog", { name: "Wednesday, July 1, 2026" });
    await expect(preview).toBeVisible();
    const detail = preview.getByRole("link", { name: "Open full detail" });
    await expect(detail).toHaveAttribute("href", `${ATTENDANCE_URL}?date=${CALENDAR_DATE}`);
    await detail.click();

    await expect(page).toHaveURL(new RegExp(`${ATTENDANCE_URL}\\?date=${CALENDAR_DATE}$`));
    await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();
    await page.getByLabel("Notes").fill(`Calendar ${viewport.name} proof`);
    await page.getByRole("button", { name: "Save & sync" }).click();
    await expect(page.getByText("Saved to Google Sheets.")).toBeVisible();

    expect(
      await page.evaluate(() => document.body.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);

    if (viewport.name === "mobile") {
      const separation = await page.evaluate(() => {
        const actions = document.querySelector(".attendance-actions")?.getBoundingClientRect();
        const navigation = document.querySelector(".app-nav")?.getBoundingClientRect();
        return actions && navigation ? navigation.top - actions.bottom : -1;
      });
      expect(separation).toBeGreaterThanOrEqual(0);
    }
  });
}

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

  await page.getByRole("button", { name: "Save & sync" }).click();

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

  await page.getByRole("button", { name: "Save & sync" }).click();

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

  await page.getByRole("button", { name: "Save & sync" }).click();

  await expect(page.getByText("Clock out must be later than clock in.")).toBeVisible();
  await expect(page.getByText("Saved to Google Sheets.")).toHaveCount(0);
});

/**
 * Moving day with unsaved work goes through, and the work is still there on the
 * way back. Only the real browser can prove the round trip, because what holds
 * the day in between is the real `attendance-local` database.
 */
test("moving to another day keeps the unsaved work and does not stop to ask", async ({ page }) => {
  await page.goto(ATTENDANCE_URL);
  await expect(page.getByRole("heading", { name: "Day summary" })).toBeVisible();

  await page.getByLabel("Notes").fill(NOTES);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Next day" }).click();

  await expect(page.getByRole("button", { name: /^Choose day/ })).toHaveText(/2026-07-02/);
  await expect(page.getByRole("button", { name: "Keep editing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
  await expect(page.getByLabel("Notes")).toHaveValue("");

  await page.getByRole("button", { name: "Previous day" }).click();

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
