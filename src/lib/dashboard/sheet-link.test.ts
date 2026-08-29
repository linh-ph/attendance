import { describe, expect, it } from "vitest";
import { parseSheetLink } from "./sheet-link";

describe("parseSheetLink", () => {
  it("reads the spreadsheet ID and gid from a standard edit URL", () => {
    expect(
      parseSheetLink("https://docs.google.com/spreadsheets/d/1AbC-dEf_gH23/edit#gid=456"),
    ).toEqual({ spreadsheetId: "1AbC-dEf_gH23", sheetId: "456" });
  });

  it("reads the gid from the query string as well as the hash", () => {
    expect(
      parseSheetLink("https://docs.google.com/spreadsheets/d/1AbC-dEf_gH23/edit?gid=789"),
    ).toEqual({ spreadsheetId: "1AbC-dEf_gH23", sheetId: "789" });
  });

  it("accepts the multi-account /u/0/ form", () => {
    expect(
      parseSheetLink("https://docs.google.com/spreadsheets/u/0/d/1AbC-dEf_gH23/edit"),
    ).toEqual({ spreadsheetId: "1AbC-dEf_gH23", sheetId: null });
  });

  it("accepts a URL with no /edit suffix and ignores sharing parameters", () => {
    expect(
      parseSheetLink("https://docs.google.com/spreadsheets/d/1AbC-dEf_gH23?usp=sharing"),
    ).toEqual({ spreadsheetId: "1AbC-dEf_gH23", sheetId: null });
  });

  it("accepts a bare spreadsheet ID", () => {
    expect(parseSheetLink("  1AbC-dEf_gH23  ")).toEqual({
      spreadsheetId: "1AbC-dEf_gH23",
      sheetId: null,
    });
  });

  it("rejects a look-alike host so a pasted phishing link never resolves", () => {
    expect(parseSheetLink("https://docs.google.com.evil.test/spreadsheets/d/1AbC-dEf_gH23")).toBe(
      null,
    );
    expect(parseSheetLink("https://evil.test/spreadsheets/d/1AbC-dEf_gH23")).toBe(null);
    // A suffix check would accept this one, so the host must match exactly.
    expect(parseSheetLink("https://evildocs.google.com/spreadsheets/d/1AbC-dEf_gH23")).toBe(null);
  });

  it("rejects a Google link that is not a spreadsheet", () => {
    expect(parseSheetLink("https://docs.google.com/document/d/1AbC-dEf_gH23/edit")).toBe(null);
    expect(parseSheetLink("https://drive.google.com/file/d/1AbC-dEf_gH23/view")).toBe(null);
  });

  it("rejects empty, malformed, and non-ID input", () => {
    for (const input of ["", "   ", "not a link", "https://docs.google.com/spreadsheets/d/"]) {
      expect(parseSheetLink(input)).toBe(null);
    }
  });

  it("rejects a gid that is not a number so it can never forge a sheet ID", () => {
    expect(
      parseSheetLink("https://docs.google.com/spreadsheets/d/1AbC-dEf_gH23/edit#gid=abc"),
    ).toEqual({ spreadsheetId: "1AbC-dEf_gH23", sheetId: null });
  });
});
