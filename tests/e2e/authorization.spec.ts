import { expect, test, type APIResponse } from "@playwright/test";
import {
  E2E_FIXTURE,
  E2E_SECRET,
  EMPLOYEE_STORAGE_STATE,
  MANAGER_STORAGE_STATE,
  resetStore,
} from "../../playwright.config";

/**
 * The refusals (design section 7.3) and the test-bypass boundary.
 *
 * Every check here runs against the committed authorization code: the browser
 * proof relaxes nothing, and a refusal must disclose nothing about the member
 * whose sheet was requested.
 */

const OWN_SHEET_PATH = `/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.employeeSheetId}`;
const OWN_SHEET_API = `/api/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.employeeSheetId}`;
const OTHER_SHEET_PATH = `/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.teammateSheetId}`;
const OTHER_SHEET_API = `/api/files/${E2E_FIXTURE.readyFile.id}/attendance/${E2E_FIXTURE.teammateSheetId}`;

const INJECTED_NOTE = "injected-by-another-employee";

function saveBody(value: string) {
  return { date: "2026-07-01", patches: [{ field: "notes", baseline: "", value }] };
}

async function bodyOf(response: APIResponse): Promise<string> {
  return await response.text();
}

test.describe("employee refusals", () => {
  test.use({ storageState: EMPLOYEE_STORAGE_STATE });

  test.beforeEach(async ({ page }) => {
    await resetStore(page.request);
  });

  test("requesting another member's sheet URL is refused and discloses nothing", async ({
    page,
  }) => {
    await page.goto(OTHER_SHEET_PATH);

    // The page shell renders no attendance value of its own, and the editor
    // reports the refusal without naming the other member.
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not load this timesheet." }),
    ).toBeVisible();
    await expect(page.getByText(E2E_FIXTURE.teammateEmail)).toHaveCount(0);
    await expect(page.getByText(E2E_FIXTURE.teammateSheetTitle)).toHaveCount(0);
  });

  test("the attendance API answers 403 for another member's sheet", async ({ page }) => {
    const read = await page.request.get(OTHER_SHEET_API);
    expect(read.status()).toBe(403);

    const body = await bodyOf(read);
    expect(body).toContain("You do not have access to this attendance sheet.");
    expect(body).not.toContain(E2E_FIXTURE.teammateEmail);
    expect(body).not.toContain(E2E_FIXTURE.teammateSheetTitle);

    const write = await page.request.post(OTHER_SHEET_API, { data: saveBody(INJECTED_NOTE) });
    expect(write.status()).toBe(403);
  });

  test("a refused write never reaches the other member's sheet", async ({ page, browser }) => {
    const refused = await page.request.post(OTHER_SHEET_API, { data: saveBody(INJECTED_NOTE) });
    expect(refused.status()).toBe(403);

    // A second, manager-owned context reads the same live store — no reseed in
    // between — so the tab is inspected exactly as the refused write left it.
    const managerContext = await browser.newContext({ storageState: MANAGER_STORAGE_STATE });
    try {
      const managerRead = await managerContext.request.get(
        `http://127.0.0.1:3100${OTHER_SHEET_API}`,
      );

      expect(managerRead.status()).toBe(200);
      expect(await bodyOf(managerRead)).not.toContain(INJECTED_NOTE);
    } finally {
      await managerContext.close();
    }
  });

  test("an employee cannot read or change the roster of a file they do not own", async ({
    page,
  }) => {
    const roster = await page.request.get(`/api/files/${E2E_FIXTURE.readyFile.id}/members`);
    expect(roster.status()).toBe(403);

    const invite = await page.request.post(`/api/files/${E2E_FIXTURE.readyFile.id}/members`, {
      data: { displayName: "Intruder", email: "intruder@blended-asia.com" },
    });
    expect(invite.status()).toBe(403);
  });

  test("the employee's own mapped sheet still works", async ({ page }) => {
    const own = await page.request.get(OWN_SHEET_API);

    expect(own.status()).toBe(200);
    expect(await bodyOf(own)).not.toContain(E2E_FIXTURE.teammateEmail);
  });
});

test.describe("the test bypass is not a way in", () => {
  test.use({ storageState: EMPLOYEE_STORAGE_STATE });

  test("the control endpoint is invisible without the shared secret", async ({ page }) => {
    const missing = await page.request.post("/api/e2e/reset", { data: {} });
    expect(missing.status()).toBe(404);
    expect(await bodyOf(missing)).toBe("");

    const wrong = await page.request.post("/api/e2e/reset", {
      headers: { "X-E2E-Secret": "guess" },
      data: {},
    });
    expect(wrong.status()).toBe(404);
    expect(await bodyOf(wrong)).toBe("");

    // Same length, different case: a sloppy comparison would let this through.
    const nearMiss = await page.request.post("/api/e2e/reset", {
      headers: { "X-E2E-Secret": E2E_SECRET.toUpperCase() },
      data: {},
    });
    expect(nearMiss.status()).toBe(404);
  });

  test("a refused control request cannot switch identity", async ({ page }) => {
    await page.request.post("/api/e2e/reset", {
      headers: { "X-E2E-Secret": "guess" },
      data: { signInAs: E2E_FIXTURE.managerEmail },
    });

    await page.goto("/dashboard");

    // Still the employee: the shell identity did not change and no manager-only
    // file content appeared.
    await expect(
      page.getByRole("link", { name: `Account ${E2E_FIXTURE.employeeEmail}` }),
    ).toBeVisible();
    await expect(page.getByText(E2E_FIXTURE.legacyFile.name)).toHaveCount(0);
  });
});

test.describe("anonymous access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the control endpoint is unreachable without a session", async ({ page }) => {
    const response = await page.request.post("/api/e2e/reset", {
      headers: { "X-E2E-Secret": E2E_SECRET },
      data: { signInAs: E2E_FIXTURE.managerEmail },
      maxRedirects: 0,
    });

    // The application proxy sends it to sign in; the handler never runs.
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/login");
  });

  test("every attendance surface requires a session", async ({ page }) => {
    await page.goto(OWN_SHEET_PATH);
    await expect(page).toHaveURL(/\/login(\?|$)/);

    const api = await page.request.get(OWN_SHEET_API, { maxRedirects: 0 });
    expect([307, 401]).toContain(api.status());
  });
});
