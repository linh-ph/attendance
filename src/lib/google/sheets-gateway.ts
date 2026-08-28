import { normalizeGoogleError } from "./errors";
import {
  SPREADSHEET_SNAPSHOT_FIELDS,
  type CellValue,
  type RangeValues,
  type SheetBatchReply,
  type SheetReplyResource,
  type SheetResource,
  type SheetSummary,
  type SheetsClient,
  type SheetsGateway,
  type ValueRangeResource,
} from "./types";

const UNFORMATTED_VALUE = "UNFORMATTED_VALUE";
const USER_ENTERED = "USER_ENTERED";

function toSheetSummary(sheet: SheetResource, index: number): SheetSummary {
  const properties = sheet.properties ?? {};

  return {
    sheetId: properties.sheetId ?? 0,
    title: properties.title ?? "",
    index: properties.index ?? index,
    hidden: properties.hidden === true,
    protectedRanges: (sheet.protectedRanges ?? [])
      .filter((range) => typeof range.protectedRangeId === "number")
      .map((range) => ({
        protectedRangeId: range.protectedRangeId as number,
        sheetId: range.range?.sheetId ?? null,
      })),
  };
}

function toBatchReply(reply: SheetReplyResource): SheetBatchReply {
  const narrowed: SheetBatchReply = {};
  const addedSheet = reply.addSheet?.properties;
  const addedProtection = reply.addProtectedRange?.protectedRange;

  if (addedSheet && typeof addedSheet.sheetId === "number") {
    narrowed.addSheet = { sheetId: addedSheet.sheetId, title: addedSheet.title ?? "" };
  }

  if (addedProtection && typeof addedProtection.protectedRangeId === "number") {
    narrowed.addProtectedRange = { protectedRangeId: addedProtection.protectedRangeId };
  }

  return narrowed;
}

function toRangeValues(valueRange: ValueRangeResource): RangeValues {
  return {
    range: valueRange.range ?? "",
    values: (valueRange.values ?? []).map((row) => row.map((cell) => cell as CellValue)),
  };
}

export function createSheetsGateway(sheets: SheetsClient): SheetsGateway {
  return {
    async getSpreadsheet(fileId, fields = SPREADSHEET_SNAPSHOT_FIELDS) {
      try {
        const { data } = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields });

        return {
          spreadsheetId: data.spreadsheetId ?? fileId,
          sheets: (data.sheets ?? []).map(toSheetSummary),
        };
      } catch (error) {
        throw normalizeGoogleError(error, "spreadsheets.get");
      }
    },

    async batchUpdate(fileId, requests) {
      try {
        const { data } = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: fileId,
          requestBody: { requests },
        });

        return {
          spreadsheetId: data.spreadsheetId ?? fileId,
          replies: (data.replies ?? []).map(toBatchReply),
        };
      } catch (error) {
        throw normalizeGoogleError(error, "spreadsheets.batchUpdate");
      }
    },

    async getValues(fileId, ranges) {
      if (ranges.length === 0) {
        return [];
      }

      try {
        const { data } = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: fileId,
          ranges,
          valueRenderOption: UNFORMATTED_VALUE,
        });

        return (data.valueRanges ?? []).map(toRangeValues);
      } catch (error) {
        throw normalizeGoogleError(error, "values.batchGet");
      }
    },

    async updateValues(fileId, patches) {
      if (patches.length === 0) {
        return;
      }

      try {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: fileId,
          requestBody: { valueInputOption: USER_ENTERED, data: patches },
        });
      } catch (error) {
        throw normalizeGoogleError(error, "values.batchUpdate");
      }
    },
  };
}
