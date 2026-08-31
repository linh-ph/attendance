import { expect, test } from "@playwright/test";

/**
 * The login surface at the two widths the specification names.
 *
 * The 390 x 844 case exists because it is the one requirement a person cannot
 * check by hand here: the browser tooling used during development clamps the
 * viewport at 500 px, so "the primary action stays visible without excessive
 * scrolling" was measured at the wrong width or not at all. Playwright can set
 * the exact viewport, so the claim is asserted rather than estimated.
 */

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

// These pages are public, so no signed-in state is needed or wanted here.
test.use({ storageState: { cookies: [], origins: [] } });

for (const path of ["/login", "/"] as const) {
  test.describe(`the unauthenticated entry point at ${path}`, () => {
    test("offers one primary action and the three explanations", async ({ page }) => {
      await page.goto(path);

      await expect(
        page.getByRole("button", { name: "Continue with Google" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

      // Spec 8.1: the account, the permissions it acts under, and the absence
      // of a password are each stated, not implied.
      await expect(page.getByText("Google Workspace").first()).toBeVisible();
      await expect(page.getByText("Your Drive permissions")).toBeVisible();
      await expect(page.getByText("No separate password")).toBeVisible();
    });

    test("keeps the retained artwork whole on a phone", async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto(path);

      const artwork = page.locator("img.login-image");
      await expect(artwork).toBeVisible();

      // A missing or renamed file still renders an <img>, so assert the bytes
      // decoded, and that the box keeps the source's own 387 x 516 ratio rather
      // than being cropped to fill.
      const box = await artwork.evaluate((image: HTMLImageElement) => ({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: image.getBoundingClientRect().width,
        renderedHeight: image.getBoundingClientRect().height,
      }));

      expect(box.naturalWidth).toBeGreaterThan(0);

      const sourceRatio = box.naturalWidth / box.naturalHeight;
      const renderedRatio = box.renderedWidth / box.renderedHeight;
      expect(Math.abs(renderedRatio - sourceRatio)).toBeLessThan(0.02);
    });

    test("keeps the primary action in view at 390 x 844", async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto(path);

      const action = page.getByRole("button", { name: "Continue with Google" });
      const box = await action.boundingBox();

      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);

      // Touch target, not just visibility.
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });

    test("does not overflow horizontally at either width", async ({ page }) => {
      for (const viewport of [PHONE, DESKTOP]) {
        await page.setViewportSize(viewport);
        await page.goto(path);

        // `body`, not `html`: the root sets `overflow-x: hidden`, which would
        // hide a real overflow from this assertion.
        const overflow = await page.evaluate(
          () => document.body.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      }
    });
  });
}
