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
  type SpreadsheetResource,
  type ValueInputOption,
  type ValuePatch,
  type ValueRangePayload,
  type ValueRangeResource,
} from "./types";

const UNFORMATTED_VALUE = "UNFORMATTED_VALUE";
const USER_ENTERED: ValueInputOption = "USER_ENTERED";

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

/**
 * The spreadsheet's own timezone, or `null` when Sheets does not report one.
 *
 * Transport normalization only — the string is passed through untouched apart
 * from trimming. Whether it is a usable IANA identifier is a domain question,
 * answered by `src/lib/attendance/zone.ts`; guessing a default here would be
 * exactly the silent fallback the calendar must never make.
 */
function toTimeZone(properties: SpreadsheetResource["properties"]): string | null {
  const raw = properties?.timeZone;
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
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

/**
 * Splits patches into one `values.batchUpdate` payload per input option.
 *
 * The Sheets API applies a single `valueInputOption` to a whole batch, so a
 * `RAW` note cannot share a call with a `USER_ENTERED` formula. Insertion order
 * is preserved, and the per-patch option never reaches the wire payload.
 */
function groupByInputOption(patches: ValuePatch[]): Map<ValueInputOption, ValueRangePayload[]> {
  const groups = new Map<ValueInputOption, ValueRangePayload[]>();

  for (const patch of patches) {
    const option = patch.inputOption ?? USER_ENTERED;
    const group = groups.get(option) ?? [];
    group.push({ range: patch.range, values: patch.values });
    groups.set(option, group);
  }

  return groups;
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
          timeZone: toTimeZone(data.properties),
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
        for (const [valueInputOption, data] of groupByInputOption(patches)) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: fileId,
            requestBody: { valueInputOption, data },
          });
        }
      } catch (error) {
        throw normalizeGoogleError(error, "values.batchUpdate");
      }
    },
  };
}
