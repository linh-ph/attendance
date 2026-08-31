import { describe, expect, it } from "vitest";
import {
  COMPACT_DESTINATIONS,
  MANAGEMENT_DESTINATIONS,
  NAV_DESTINATIONS,
  WORKSPACE_DESTINATIONS,
  currentNavIds,
  initialsFromEmail,
  type NavSurface,
} from "./navigation";

/**
 * The navigation model is the single list both shells render, so the
 * information architecture cannot diverge between desktop and mobile by
 * accident — it can only diverge by editing this file.
 */

const labelsFor = (surfaces: readonly NavSurface[]) =>
  NAV_DESTINATIONS.filter((item) => surfaces.includes(item.surface)).map((item) => item.label);

describe("the navigation model", () => {
  it("offers Calendar, Timesheets, Managed files and Members on the desktop sidebar", () => {
    expect(labelsFor(["both", "desktop"])).toEqual([
      "Calendar",
      "Timesheets",
      "Managed files",
      "Members",
    ]);
  });

  it("offers Calendar, Timesheets, Manage and More on the mobile bottom navigation", () => {
    expect(labelsFor(["both", "mobile"])).toEqual(["Calendar", "Timesheets", "Manage", "More"]);
  });

  it("keeps the shared destinations identically named and addressed on both shells", () => {
    const shared = NAV_DESTINATIONS.filter((item) => item.surface === "both");

    expect(shared.map((item) => [item.label, item.href])).toEqual([
      ["Calendar", "/dashboard"],
      ["Timesheets", "/timesheets"],
    ]);
  });

  it("opens Managed files by default from the mobile Manage destination", () => {
    const managedFiles = NAV_DESTINATIONS.find((item) => item.id === "managed-files");
    const manage = NAV_DESTINATIONS.find((item) => item.id === "manage");

    expect(manage?.href).toBe(managedFiles?.href);
    expect(manage?.href).toBe("/manage");
  });

  it("introduces no Help or Settings destination", () => {
    const labels = NAV_DESTINATIONS.map((item) => item.label.toLowerCase());

    expect(labels.some((label) => label.includes("help"))).toBe(false);
    expect(labels.some((label) => label.includes("setting"))).toBe(false);
  });

  it("renders employee work before management in the sidebar order", () => {
    expect(WORKSPACE_DESTINATIONS.map((item) => item.id)).toEqual(["calendar", "timesheets"]);
    expect(MANAGEMENT_DESTINATIONS.map((item) => item.id)).toEqual(["managed-files", "members"]);
    expect(COMPACT_DESTINATIONS.map((item) => item.id)).toEqual(["manage", "more"]);
  });

  it("lists every destination exactly once", () => {
    const ids = NAV_DESTINATIONS.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("currentNavIds", () => {
  it("marks Calendar on the dashboard", () => {
    expect([...currentNavIds("/dashboard")]).toEqual(["calendar"]);
  });

  it("marks Timesheets on the timesheets page and inside a day editor", () => {
    expect([...currentNavIds("/timesheets")]).toEqual(["timesheets"]);
    expect([...currentNavIds("/files/file-1/attendance/12345")]).toEqual(["timesheets"]);
    expect([...currentNavIds("/files/file-1/attendance")]).toEqual(["timesheets"]);
  });

  it("marks Members on both shells, because Manage owns Members on mobile", () => {
    expect([...currentNavIds("/members")].sort()).toEqual(["manage", "members"]);
    expect([...currentNavIds("/files/file-1/members")].sort()).toEqual(["manage", "members"]);
  });

  it("marks Managed files for the management hub and every file wizard", () => {
    expect([...currentNavIds("/manage")].sort()).toEqual(["manage", "managed-files"]);
    expect([...currentNavIds("/files/new")].sort()).toEqual(["manage", "managed-files"]);
    expect([...currentNavIds("/files/import")].sort()).toEqual(["manage", "managed-files"]);
    expect([...currentNavIds("/files/file-1/setup")].sort()).toEqual(["manage", "managed-files"]);
  });

  it("marks More and the sidebar account link on the account page", () => {
    expect([...currentNavIds("/more")].sort()).toEqual(["account", "more"]);
  });

  it("tolerates a trailing slash and marks nothing off the map", () => {
    expect([...currentNavIds("/dashboard/")]).toEqual(["calendar"]);
    expect([...currentNavIds("/login")]).toEqual([]);
    expect([...currentNavIds("")]).toEqual([]);
  });
});

describe("initialsFromEmail", () => {
  it("takes the first letters of a dotted local part", () => {
    expect(initialsFromEmail("linh.np@blended-asia.com")).toBe("LN");
  });

  it("falls back to the first two letters of a single-word local part", () => {
    expect(initialsFromEmail("manager@blended-asia.com")).toBe("MA");
  });

  it("never returns an empty mark", () => {
    expect(initialsFromEmail("@blended-asia.com")).toBe("?");
    expect(initialsFromEmail("")).toBe("?");
  });
});
