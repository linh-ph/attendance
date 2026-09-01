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

  /**
   * Another member's visible tab is **not** refused any more.
   *
   * Google's own sharing is the boundary: every member already has edit access
   * to the whole file, so the app refusing this only ever stopped the people
   * using the app. See `docs/decisions/2026-08-29-app-is-a-sheets-client.md`.
   */
  test("another member's visible tab opens, because Google already allows it", async ({ page }) => {
    const read = await page.request.get(OTHER_SHEET_API);

    expect(read.status()).toBe(200);
    expect(await bodyOf(read)).toContain(E2E_FIXTURE.teammateSheetTitle);
  });

  test("the hidden configuration tab is refused, for reads and for writes", async ({ page }) => {
    const configApi = `/api/files/${E2E_FIXTURE.readyFile.id}/attendance/100`;

    const read = await page.request.get(configApi);
    expect(read.status()).toBe(403);
    expect(await bodyOf(read)).toContain("You do not have access to this attendance sheet.");

    const write = await page.request.post(configApi, { data: saveBody(INJECTED_NOTE) });
    expect(write.status()).toBe(403);
  });

  test("a tab the file does not have is refused, and discloses nothing", async ({ page }) => {
    const missingApi = `/api/files/${E2E_FIXTURE.readyFile.id}/attendance/999999`;

    const read = await page.request.get(missingApi);
    expect(read.status()).toBe(403);

    const body = await bodyOf(read);
    expect(body).toContain("You do not have access to this attendance sheet.");
    expect(body).not.toContain(E2E_FIXTURE.teammateEmail);
    expect(body).not.toContain(E2E_FIXTURE.teammateSheetTitle);
  });

  test("a refused write never reaches the sheet", async ({ page, browser }) => {
    const configApi = `/api/files/${E2E_FIXTURE.readyFile.id}/attendance/100`;
    const refused = await page.request.post(configApi, { data: saveBody(INJECTED_NOTE) });
    expect(refused.status()).toBe(403);

    // A second, manager-owned context reads the same live store — no reseed in
    // between — so the file is inspected exactly as the refused write left it.
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
