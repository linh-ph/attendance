import { expect, test as setup } from "@playwright/test";
import {
  E2E_FIXTURE,
  EMPLOYEE_STORAGE_STATE,
  MANAGER_STORAGE_STATE,
  signInAs,
} from "../../playwright.config";

/**
 * The Google sign-in boundary, proven through the deterministic test adapter.
 *
 * The adapter mints a genuine Auth.js session cookie rather than bypassing the
 * session: the proxy, the server pages, and every Route Handler run their real
 * checks against it. Both signed-in states are saved so the workflow specs can
 * start from a real session instead of re-authenticating for every test.
 */

setup("an unauthenticated visitor is sent to sign in", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole("heading", { name: "Attendance", level: 1 })).toBeVisible();
  await expect(page.getByText("blended-asia")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

setup("the sign-in artwork loads for a visitor with no session", async ({ page }) => {
  await page.goto("/login");

  // Presence in the DOM is not enough — a missing or renamed file still
  // renders an <img> — so this asserts the bytes actually decoded.
  //
  // It does NOT prove the proxy leaves the file public. These specs run against
  // `next dev`, which reads `public/` from disk, while the production server's
  // image optimizer fetches the file over HTTP and is therefore the only build
  // a gated static path breaks. That rule is proven in `src/proxy.test.ts`.
  const artwork = page.locator("img.hero-art");
  await expect(artwork).toBeVisible();
  await expect
    .poll(() => artwork.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});

setup("the manager signs in", async ({ page, context }) => {
  await signInAs(context, E2E_FIXTURE.managerEmail);

  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Managed attendance files" })).toBeVisible();

  await context.storageState({ path: MANAGER_STORAGE_STATE });
});

setup("the employee signs in", async ({ page, context }) => {
  await signInAs(context, E2E_FIXTURE.employeeEmail);

  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My timesheets" })).toBeVisible();

  await context.storageState({ path: EMPLOYEE_STORAGE_STATE });
});
