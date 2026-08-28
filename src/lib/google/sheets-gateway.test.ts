import { describe, expect, it } from "vitest";
import { createFakeSheetsClient } from "../../../tests/fakes/google";
import { createSheetsGateway } from "./sheets-gateway";
import { SPREADSHEET_SNAPSHOT_FIELDS } from "./types";

describe("getSpreadsheet", () => {
  it("requests the snapshot contract and normalizes sheet and protection metadata", async () => {
    const fakeSheets = createFakeSheetsClient({
      spreadsheet: {
        spreadsheetId: "file-1",
        sheets: [
          {
            properties: { sheetId: 0, title: "__APP_CONFIG", index: 0, hidden: true },
            protectedRanges: [{ protectedRangeId: 11, range: { sheetId: 0 } }],
          },
          { properties: { sheetId: 1234, title: "Employee A", index: 1 } },
        ],
      },
    });
    const gateway = createSheetsGateway(fakeSheets);

    await expect(gateway.getSpreadsheet("file-1")).resolves.toEqual({
      spreadsheetId: "file-1",
      sheets: [
        {
          sheetId: 0,
          title: "__APP_CONFIG",
          index: 0,
          hidden: true,
          protectedRanges: [{ protectedRangeId: 11, sheetId: 0 }],
        },
        { sheetId: 1234, title: "Employee A", index: 1, hidden: false, protectedRanges: [] },
      ],
    });

    expect(fakeSheets.getCalls[0]).toEqual({
      spreadsheetId: "file-1",
      fields: SPREADSHEET_SNAPSHOT_FIELDS,
    });
  });

  it("passes an explicit field mask through to the Sheets API", async () => {
    const fakeSheets = createFakeSheetsClient({ spreadsheet: { spreadsheetId: "file-1" } });
    const gateway = createSheetsGateway(fakeSheets);

    await expect(
      gateway.getSpreadsheet("file-1", "sheets(properties(sheetId,title))"),
    ).resolves.toEqual({ spreadsheetId: "file-1", sheets: [] });

    expect(fakeSheets.getCalls[0].fields).toBe("sheets(properties(sheetId,title))");
  });
});

describe("batchUpdate", () => {
  it("forwards opaque Sheets requests and narrows the replies services depend on", async () => {
    const fakeSheets = createFakeSheetsClient({
      replies: [
        { addSheet: { properties: { sheetId: 42, title: "Employee A" } } },
        {},
        { addProtectedRange: { protectedRange: { protectedRangeId: 7 } } },
      ],
    });
    const gateway = createSheetsGateway(fakeSheets);
    const requests = [
      { addSheet: { properties: { title: "Employee A" } } },
      { updateSheetProperties: { properties: { sheetId: 0, hidden: true }, fields: "hidden" } },
      { addProtectedRange: { protectedRange: { range: { sheetId: 42 } } } },
    ];

    await expect(gateway.batchUpdate("file-1", requests)).resolves.toEqual({
      spreadsheetId: "file-1",
      replies: [{ addSheet: { sheetId: 42, title: "Employee A" } }, {}, { addProtectedRange: { protectedRangeId: 7 } }],
    });

    expect(fakeSheets.batchUpdateCalls).toEqual([
      { spreadsheetId: "file-1", requestBody: { requests } },
    ]);
  });
});

describe("getValues", () => {
  it("reads the requested ranges unformatted and defaults empty ranges to no rows", async () => {
    const fakeSheets = createFakeSheetsClient({
      valueRanges: [
        { range: "Employee A!A4:I4", values: [["2026-07-01", "出社", 9, 18]] },
        { range: "Employee A!A5:I5" },
      ],
    });
    const gateway = createSheetsGateway(fakeSheets);

    await expect(
      gateway.getValues("file-1", ["Employee A!A4:I4", "Employee A!A5:I5"]),
    ).resolves.toEqual([
      { range: "Employee A!A4:I4", values: [["2026-07-01", "出社", 9, 18]] },
      { range: "Employee A!A5:I5", values: [] },
    ]);

    expect(fakeSheets.valuesGetCalls).toEqual([
      {
        spreadsheetId: "file-1",
        ranges: ["Employee A!A4:I4", "Employee A!A5:I5"],
        valueRenderOption: "UNFORMATTED_VALUE",
      },
    ]);
  });
});

describe("updateValues", () => {
  it("writes only the supplied dirty ranges in one user-entered batch", async () => {
    const fakeSheets = createFakeSheetsClient();
    const gateway = createSheetsGateway(fakeSheets);
    const patches = [
      { range: "Employee A!E4", values: [[1]] },
      { range: "Employee A!H4", values: [["=F4-G4-E4"]] },
    ];

    await gateway.updateValues("file-1", patches);

    expect(fakeSheets.valuesUpdateCalls).toEqual([
      {
        spreadsheetId: "file-1",
        requestBody: { valueInputOption: "USER_ENTERED", data: patches },
      },
    ]);
  });

  it("does not call the Sheets API when there is nothing dirty to save", async () => {
    const fakeSheets = createFakeSheetsClient();
    const gateway = createSheetsGateway(fakeSheets);

    await gateway.updateValues("file-1", []);

    expect(fakeSheets.valuesUpdateCalls).toHaveLength(0);
  });
});
