import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { FocusOnRouteChange } from "./focus-on-route-change";

const route = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
}));

const TARGET_ID = "main-content";

function mountTarget(): HTMLElement {
  const target = document.createElement("div");
  target.id = TARGET_ID;
  target.tabIndex = -1;
  document.body.append(target);
  return target;
}

afterEach(() => {
  document.getElementById(TARGET_ID)?.remove();
  route.pathname = "/dashboard";
});

describe("focus management on navigation", () => {
  it("leaves focus alone on the first render", () => {
    const target = mountTarget();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();

    render(<FocusOnRouteChange targetId={TARGET_ID} />);

    expect(document.activeElement).toBe(anchor);
    expect(document.activeElement).not.toBe(target);
    anchor.remove();
  });

  it("moves focus to the content region when the route changes", () => {
    const target = mountTarget();
    const { rerender } = render(<FocusOnRouteChange targetId={TARGET_ID} />);

    route.pathname = "/timesheets";
    rerender(<FocusOnRouteChange targetId={TARGET_ID} />);

    expect(document.activeElement).toBe(target);
  });

  it("does not steal focus when the same route re-renders", () => {
    mountTarget();
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const { rerender } = render(<FocusOnRouteChange targetId={TARGET_ID} />);

    anchor.focus();
    rerender(<FocusOnRouteChange targetId={TARGET_ID} />);

    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  });

  it("renders nothing of its own", () => {
    mountTarget();
    const { container } = render(<FocusOnRouteChange targetId={TARGET_ID} />);

    expect(container).toBeEmptyDOMElement();
  });
});
