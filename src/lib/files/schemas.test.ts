import { describe, expect, it } from "vitest";
import { createFileInputSchema } from "./schemas";

const validInput = {
  fileName: "202607勤怠管理表",
  month: "2026-07",
  destinationFolder: { id: "folder-1", name: "Attendance" },
  members: [
    { displayName: "  Employee A  ", email: "Employee-A@Blended-Asia.com" },
    { displayName: "Employee B", email: "employee-b@blended-asia.com" },
  ],
};

describe("createFileInputSchema", () => {
  it("accepts a valid create request and normalizes names and emails", () => {
    const parsed = createFileInputSchema.parse(validInput);

    expect(parsed.fileName).toBe("202607勤怠管理表");
    expect(parsed.month).toBe("2026-07");
    expect(parsed.destinationFolder).toEqual({ id: "folder-1", name: "Attendance" });
    expect(parsed.members).toEqual([
      { displayName: "Employee A", email: "employee-a@blended-asia.com" },
      { displayName: "Employee B", email: "employee-b@blended-asia.com" },
    ]);
  });

  it("trims the file name", () => {
    const parsed = createFileInputSchema.parse({ ...validInput, fileName: "  202607勤怠管理表 " });
    expect(parsed.fileName).toBe("202607勤怠管理表");
  });

  it("rejects an empty member list", () => {
    const result = createFileInputSchema.safeParse({ ...validInput, members: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a month outside the YYYY-MM format", () => {
    for (const month of ["2026-13", "2026-00", "202607", "26-07", "2026-7"]) {
      expect(createFileInputSchema.safeParse({ ...validInput, month }).success).toBe(false);
    }
  });

  it("accepts every valid month number", () => {
    for (let month = 1; month <= 12; month += 1) {
      const value = `2026-${String(month).padStart(2, "0")}`;
      expect(createFileInputSchema.safeParse({ ...validInput, month: value }).success).toBe(true);
    }
  });

  it("rejects a file name without the 勤怠管理表 marker", () => {
    const result = createFileInputSchema.safeParse({ ...validInput, fileName: "July timesheet" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty file name", () => {
    expect(createFileInputSchema.safeParse({ ...validInput, fileName: "   " }).success).toBe(false);
  });

  it("rejects a malformed member email", () => {
    const result = createFileInputSchema.safeParse({
      ...validInput,
      members: [{ displayName: "Employee A", email: "employee-a(at)blended-asia.com" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a member without a display name", () => {
    const result = createFileInputSchema.safeParse({
      ...validInput,
      members: [{ displayName: "   ", email: "employee-a@blended-asia.com" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a destination folder without an id or a name", () => {
    expect(
      createFileInputSchema.safeParse({
        ...validInput,
        destinationFolder: { id: "", name: "Attendance" },
      }).success,
    ).toBe(false);
    expect(
      createFileInputSchema.safeParse({
        ...validInput,
        destinationFolder: { id: "folder-1", name: "" },
      }).success,
    ).toBe(false);
  });
});
