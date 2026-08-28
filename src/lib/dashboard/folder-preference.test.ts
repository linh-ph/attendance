import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFolderPreference,
  folderPreferenceKey,
  readFolderPreference,
  writeFolderPreference,
} from "./folder-preference";

const MANAGER_EMAIL = "manager@blended-asia.com";
const OTHER_EMAIL = "other@blended-asia.com";

describe("folderPreferenceKey", () => {
  it("trims and lowercases the email so equivalent emails share one key", () => {
    expect(folderPreferenceKey(" Manager@Blended-Asia.com ")).toBe(
      folderPreferenceKey("manager@blended-asia.com"),
    );
    expect(folderPreferenceKey("manager@blended-asia.com")).toBe(
      "attendance.dashboardFolder:manager@blended-asia.com",
    );
  });
});

describe("folder preference storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a stored preference as { id, name }", () => {
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" });

    expect(readFolderPreference(MANAGER_EMAIL)).toEqual({
      id: "folder-1",
      name: "Attendance 2026",
    });
  });

  it("persists exactly the keys id and name, nothing more", () => {
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" });

    const raw = window.localStorage.getItem(folderPreferenceKey(MANAGER_EMAIL));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(Object.keys(parsed).sort()).toEqual(["id", "name"]);
  });

  it("never lets two signed-in emails read each other's preference", () => {
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" });
    writeFolderPreference(OTHER_EMAIL, { id: "folder-2", name: "Payroll 2026" });

    expect(readFolderPreference(MANAGER_EMAIL)).toEqual({ id: "folder-1", name: "Attendance 2026" });
    expect(readFolderPreference(OTHER_EMAIL)).toEqual({ id: "folder-2", name: "Payroll 2026" });
  });

  it("removes malformed JSON and returns no preference instead of throwing", () => {
    window.localStorage.setItem(folderPreferenceKey(MANAGER_EMAIL), "{not-json");

    expect(() => readFolderPreference(MANAGER_EMAIL)).not.toThrow();
    expect(readFolderPreference(MANAGER_EMAIL)).toBeNull();
    expect(window.localStorage.getItem(folderPreferenceKey(MANAGER_EMAIL))).toBeNull();
  });

  it.each([
    ["a JSON null", "null"],
    ["a JSON array", "[]"],
    ["a non-string id", JSON.stringify({ id: 123, name: "Attendance 2026" })],
    ["a missing name", JSON.stringify({ id: "folder-1" })],
    ["an empty-string id", JSON.stringify({ id: "", name: "Attendance 2026" })],
    ["an empty-string name", JSON.stringify({ id: "folder-1", name: "" })],
  ])("treats %s as malformed: removes it and returns no preference", (_label, stored) => {
    window.localStorage.setItem(folderPreferenceKey(MANAGER_EMAIL), stored);

    expect(readFolderPreference(MANAGER_EMAIL)).toBeNull();
    expect(window.localStorage.getItem(folderPreferenceKey(MANAGER_EMAIL))).toBeNull();
  });

  it("replaces the stored preference when the folder changes, never accumulating", () => {
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" });
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-2", name: "Attendance 2027" });

    expect(readFolderPreference(MANAGER_EMAIL)).toEqual({ id: "folder-2", name: "Attendance 2027" });
    expect(window.localStorage.length).toBe(1);
  });

  it("clears only the given email's key and leaves other emails' keys intact", () => {
    writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" });
    writeFolderPreference(OTHER_EMAIL, { id: "folder-2", name: "Payroll 2026" });

    clearFolderPreference(MANAGER_EMAIL);

    expect(readFolderPreference(MANAGER_EMAIL)).toBeNull();
    expect(readFolderPreference(OTHER_EMAIL)).toEqual({ id: "folder-2", name: "Payroll 2026" });
  });

  it("does not throw when localStorage.getItem throws (private mode / disabled storage)", () => {
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });

    expect(() => readFolderPreference(MANAGER_EMAIL)).not.toThrow();
    expect(readFolderPreference(MANAGER_EMAIL)).toBeNull();
  });

  it("does not throw when localStorage.setItem throws (private mode / disabled storage)", () => {
    vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => writeFolderPreference(MANAGER_EMAIL, { id: "folder-1", name: "Attendance 2026" })).not.toThrow();
  });

  it("does not throw when localStorage.removeItem throws (private mode / disabled storage)", () => {
    vi.spyOn(window.localStorage.__proto__, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });

    expect(() => clearFolderPreference(MANAGER_EMAIL)).not.toThrow();
  });
});
