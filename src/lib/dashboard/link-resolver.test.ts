import { describe, expect, it } from "vitest";
import type { ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import { resolveSheetLink } from "./link-resolver";

const managed = (over: Partial<ManagedFile> = {}): ManagedFile =>
  ({
    id: "1MaNaGeDfile_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    name: "202607勤怠管理表",
    ownerEmail: "manager@blended-asia.com",
    month: "2026-07",
    modifiedTime: null,
    memberCount: 3,
    setupState: "ready",
    error: null,
    ...over,
  }) as ManagedFile;

const timesheet = (over: Partial<Timesheet> = {}): Timesheet =>
  ({
    id: "1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    name: "202607勤怠管理表",
    ownerEmail: "manager@blended-asia.com",
    month: "2026-07",
    modifiedTime: null,
    sheetId: "101",
    sheetTitle: "NGUYEN PHAN LINH",
    ...over,
  }) as Timesheet;

const lists = { managed: [managed()], timesheets: [timesheet()] };

describe("resolveSheetLink", () => {
  it("sends an employee to their own mapped sheet", () => {
    expect(
      resolveSheetLink("https://docs.google.com/spreadsheets/d/1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234/edit", lists),
    ).toEqual({
      kind: "timesheet",
      href: "/files/1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234/attendance/101",
      fileId: "1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234",
      sheetId: "101",
      name: "202607勤怠管理表",
      sheetTitle: "NGUYEN PHAN LINH",
    });
  });

  it("sends a manager to the file they manage", () => {
    const result = resolveSheetLink("https://docs.google.com/spreadsheets/d/1MaNaGeDfile_AbCdEfGhIjKlMnOpQrStUvWxYz0123", lists);
    expect(result).toEqual({
      kind: "managed",
      href: "/files/1MaNaGeDfile_AbCdEfGhIjKlMnOpQrStUvWxYz0123/members",
      fileId: "1MaNaGeDfile_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
      name: "202607勤怠管理表",
    });
  });

  it("prefers the employee's own sheet when the same file appears in both lists", () => {
    const both = {
      managed: [managed({ id: "1SharedFile_AbCdEfGhIjKlMnOpQrStUvWxYz0123" })],
      timesheets: [timesheet({ id: "1SharedFile_AbCdEfGhIjKlMnOpQrStUvWxYz0123", sheetId: "202" })],
    };

    expect(resolveSheetLink("1SharedFile_AbCdEfGhIjKlMnOpQrStUvWxYz0123", both)).toMatchObject({
      kind: "timesheet",
      href: "/files/1SharedFile_AbCdEfGhIjKlMnOpQrStUvWxYz0123/attendance/202",
    });
  });

  it("reports a link that is not a Google Sheets link", () => {
    expect(resolveSheetLink("https://example.com/whatever", lists)).toEqual({
      kind: "not-a-link",
    });
    expect(resolveSheetLink("", lists)).toEqual({ kind: "not-a-link" });
  });

  it("reports no access for a well-formed link the dashboard never listed", () => {
    expect(
      resolveSheetLink("https://docs.google.com/spreadsheets/d/1SomeoneElses_AbCdEfGhIjKlMnOpQrStUvWxYz01/edit", lists),
    ).toEqual({ kind: "no-access" });
  });

  it("does not let a pasted gid address a sheet other than the mapped one", () => {
    // The link carries gid=999 but this employee is mapped to sheet 101 only.
    expect(
      resolveSheetLink("https://docs.google.com/spreadsheets/d/1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234/edit#gid=999", lists),
    ).toMatchObject({ href: "/files/1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234/attendance/101", sheetId: "101" });
  });

  it("reports no access when both lists are empty", () => {
    expect(
      resolveSheetLink("https://docs.google.com/spreadsheets/d/1MaNaGeDfile_AbCdEfGhIjKlMnOpQrStUvWxYz0123", {
        managed: [],
        timesheets: [],
      }),
    ).toEqual({ kind: "no-access" });
  });
});
