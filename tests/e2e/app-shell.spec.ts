import { expect, test, type Page } from "@playwright/test";
import { MANAGER_STORAGE_STATE, resetStore } from "../../playwright.config";

/**
 * The application shell in a real browser (design sections 3.1, 3.2 and 9).
 *
 * The unit suite proves the markup; only a browser can prove the two things
 * that matter about it: that exactly one shell is navigable at a given width,
 * and that neither of them pushes the page sideways.
 *
 * The five widths are the published breakpoints in
 * `docs/patterns/ui-redesign-contract.md`.
 */

test.use({ storageState: MANAGER_STORAGE_STATE });

const BREAKPOINTS = [
  { width: 320, height: 720, shell: "compact" },
  { width: 390, height: 844, shell: "compact" },
  { width: 768, height: 1024, shell: "compact" },
  { width: 1024, height: 768, shell: "sidebar" },
  { width: 1440, height: 900, shell: "sidebar" },
] as const;

test.beforeEach(async ({ page }) => {
  await resetStore(page.request);
});

/**
 * The widest laid-out box against the viewport.
 *
 * `html` is `overflow-x: hidden`, which clips its own `scrollWidth`, so asking
 * the root would answer "no overflow" even when there is some. `body` is not
 * clipped, so it still reports content that runs past the edge.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.body.scrollWidth - window.innerWidth);
}

for (const { width, height, shell } of BREAKPOINTS) {
  test(`the ${shell} shell fits ${width}px without pushing the page sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("the sidebar carries the whole information architecture on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");

  const navigation = page.getByRole("navigation", { name: "Main" });

  await expect(navigation.getByRole("link", { name: "Calendar" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Timesheets" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Managed files" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Members" })).toBeVisible();

  // Management is labelled, not hidden behind a role switch.
  await expect(page.getByRole("list", { name: "Management" })).toBeVisible();

  // The compact entries belong to the other shell and are out of the tree.
  await expect(navigation.getByRole("link", { name: "Manage", exact: true })).toBeHidden();
  await expect(navigation.getByRole("link", { name: "More" })).toBeHidden();

  // Identity and the session control sit at the foot.
  await expect(page.getByRole("link", { name: /Account/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("the bottom navigation carries the same architecture on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");

  const navigation = page.getByRole("navigation", { name: "Main" });

  await expect(navigation.getByRole("link", { name: "Calendar" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Timesheets" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Manage", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "More" })).toBeVisible();

  // The sidebar's entries and its account foot belong to the other shell.
  await expect(navigation.getByRole("link", { name: "Managed files" })).toBeHidden();
  await expect(navigation.getByRole("link", { name: "Members" })).toBeHidden();
  await expect(page.getByRole("link", { name: /Account/ })).toBeHidden();

  // Every target meets the WCAG 2.2 pointer minimum.
  for (const name of ["Calendar", "Timesheets", "Manage", "More"]) {
    const box = await navigation
      .getByRole("link", { name, exact: true })
      .boundingBox();

    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("no Help or Settings destination exists on either shell", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dashboard");

    await expect(page.getByRole("link", { name: /help/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /settings/i })).toHaveCount(0);
  }
});

test("the skip link is the first stop and jumps into the content", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  await page.keyboard.press("Tab");

  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  // Off-screen until focused, on-screen the moment it is.
  await expect(skip).toBeInViewport();

  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toBe("main-content");
});

test("every sidebar destination is reachable in reading order", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Main" });

  // Skip link, brand, then the destinations, then identity and Sign out.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Attendance/ })).toBeFocused();

  for (const name of ["Calendar", "Timesheets", "Managed files", "Members"]) {
    await page.keyboard.press("Tab");
    await expect(navigation.getByRole("link", { name, exact: true })).toBeFocused();
  }

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Account/ })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
});

test("navigating marks the new page and moves focus into it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");

  const navigation = page.getByRole("navigation", { name: "Main" });

  await expect(navigation.getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await navigation.getByRole("link", { name: "Timesheets", exact: true }).click();

  await expect(page).toHaveURL(/\/timesheets$/);
  await expect(page.getByRole("heading", { name: "Timesheets", level: 1 })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Timesheets", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    navigation.getByRole("link", { name: "Calendar", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");

  // A keyboard user lands at the top of the page they asked for.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toBe("main-content");
});

test("the compact shell reaches Members and Sign out through Manage and More", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");

  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Managed files", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Members" })).toBeVisible();

  await page.getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { name: "More", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
