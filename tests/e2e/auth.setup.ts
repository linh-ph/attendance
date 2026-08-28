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
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
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
