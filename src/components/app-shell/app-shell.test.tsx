import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AppShell, MAIN_CONTENT_ID } from "./app-shell";

/** The route the shell believes it is on; mutable so one suite can visit many. */
const route = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
}));

const EMAIL = "linh.np@blended-asia.com";

const renderShell = (pathname: string) => {
  route.pathname = pathname;

  return render(
    <AppShell email={EMAIL} signOut={<button type="submit">Sign out</button>}>
      <main>
        <h1>Dashboard</h1>
      </main>
    </AppShell>,
  );
};

afterEach(() => {
  route.pathname = "/dashboard";
});

describe("the application shell", () => {
  it("renders one banner and one named navigation landmark", () => {
    renderShell("/dashboard");

    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);
  });

  it("exposes the same information architecture to both shells", () => {
    renderShell("/dashboard");

    const navigation = screen.getByRole("navigation", { name: "Main" });
    const labels = within(navigation)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());

    expect(labels).toEqual([
      "Calendar",
      "Timesheets",
      "Managed files",
      "Members",
      "Manage",
      "More",
    ]);
  });

  it("groups Managed files and Members under a labelled Management group", () => {
    renderShell("/dashboard");

    const management = screen.getByRole("list", { name: "Management" });

    expect(
      within(management)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual(["Managed files", "Members"]);
  });

  it("addresses each destination at its published route", () => {
    renderShell("/dashboard");

    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "Timesheets" })).toHaveAttribute("href", "/timesheets");
    expect(screen.getByRole("link", { name: "Managed files" })).toHaveAttribute("href", "/manage");
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/manage");
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("href", "/more");
  });

  it("marks the current page on whichever shell is showing", () => {
    renderShell("/files/file-1/attendance/900");

    expect(screen.getByRole("link", { name: "Timesheets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Calendar" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Manage" })).not.toHaveAttribute("aria-current");
  });

  it("marks both Members and the mobile Manage destination on the member roster", () => {
    renderShell("/members");

    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("aria-current", "page");
  });

  it("opens with a skip link that targets the content region", () => {
    renderShell("/dashboard");

    const skip = screen.getByRole("link", { name: "Skip to main content" });
    const region = document.getElementById(MAIN_CONTENT_ID);

    expect(skip).toHaveAttribute("href", `#${MAIN_CONTENT_ID}`);
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("tabindex", "-1");
    expect(within(region as HTMLElement).getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  it("puts the skip link first in the keyboard order", () => {
    const { container } = renderShell("/dashboard");
    const focusable = container.querySelectorAll("a[href], button, [tabindex]");

    expect(focusable[0]).toHaveTextContent("Skip to main content");
  });

  it("carries the signed-in identity and the sign-out control at the foot of the sidebar", () => {
    renderShell("/dashboard");

    const account = screen.getByRole("link", { name: /Account/ });

    expect(account).toHaveAttribute("href", "/more");
    expect(account).toHaveTextContent(EMAIL);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("marks the sidebar account link when the account page is open", () => {
    renderShell("/more");

    expect(screen.getByRole("link", { name: /Account/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");
  });
});
