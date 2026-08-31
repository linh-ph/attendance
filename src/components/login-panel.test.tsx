import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginPanel } from "./login-panel";

/**
 * The login surface carries product requirements, not just styling, so they are
 * asserted here rather than left to a screenshot.
 *
 * Spec §2.3 retains `public/meme.jpeg` on both desktop and mobile, complete and
 * at its original aspect ratio. Spec §8.1 requires one primary action and three
 * specific explanations, and a mobile order of brand, image, message, action,
 * trust cue — which is DOM order, because that is what a stacked layout follows.
 */

function renderPanel() {
  return render(
    <LoginPanel action={<button type="submit">Continue with Google</button>} />,
  );
}

describe("LoginPanel", () => {
  it("gives the page exactly one level-one heading", () => {
    renderPanel();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps the retained artwork decorative and out of the accessibility tree", () => {
    const { container } = renderPanel();

    // `alt=""` is the product decision in §2.3, so no image role may appear.
    expect(screen.queryByRole("img")).toBeNull();

    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toContain("meme");
    expect(images[0].getAttribute("alt")).toBe("");
  });

  it("renders the artwork at its original aspect ratio so it is never cropped", () => {
    const { container } = renderPanel();
    const image = container.querySelector("img");

    // The source file is 387 x 516. Declaring both reserves the right box and
    // keeps `object-fit: contain` showing the whole frame rather than a crop.
    expect(image?.getAttribute("width")).toBe("387");
    expect(image?.getAttribute("height")).toBe("516");
  });

  it("shows the one primary action it was given", () => {
    renderPanel();

    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeDefined();
  });

  it("explains the workspace account, the Drive permissions, and the absent password", () => {
    const { container } = renderPanel();
    const text = container.textContent ?? "";

    expect(text).toMatch(/blended-asia/i);
    expect(text).toMatch(/workspace/i);
    expect(text).toMatch(/drive permission/i);
    expect(text).toMatch(/no separate password/i);
  });

  it("stacks brand, image, message, action, then trust cue in that order", () => {
    const { container } = renderPanel();

    const order = [
      container.querySelector("[data-login='brand']"),
      container.querySelector("img"),
      container.querySelector("h1"),
      container.querySelector("[data-login='action']"),
      container.querySelector("[data-login='trust']"),
    ];

    expect(order.every(Boolean)).toBe(true);

    for (let i = 1; i < order.length; i += 1) {
      const relation = order[i - 1]!.compareDocumentPosition(order[i]!);
      // Node.DOCUMENT_POSITION_FOLLOWING — the next landmark comes after.
      expect(relation & 4).toBe(4);
    }
  });
});
