/**
 * Applies one Sheets `batchUpdate` request to the in-memory workbook.
 *
 * Every request the product code actually sends is modelled as a real state
 * change and answered with the reply shape the caller reads back, so setup,
 * import, and the template all reconcile against what they created rather than
 * against a canned response.
 */

import type { CellValue, SheetBatchReply, SheetRequest } from "@/lib/google/types";
import {
  makeSheet,
  protect,
  writeCell,
  type FakeFile,
  type FakeGoogleStore,
  type FakeSheet,
} from "./fake-google-state";

interface GridRangeResource {
  sheetId?: number;
  startRowIndex?: number;
  startColumnIndex?: number;
}

interface CellDataResource {
  userEnteredValue?: {
    stringValue?: string;
    numberValue?: number;
    boolValue?: boolean;
    formulaValue?: string;
  };
}

function toCellValue(cell: CellDataResource | undefined): CellValue {
  const value = cell?.userEnteredValue;
  if (value === undefined) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.formulaValue !== undefined) return value.formulaValue;
  return "";
}

function read<T>(request: SheetRequest, key: string): T | undefined {
  return request[key] as T | undefined;
}

function findSheetById(file: FakeFile, sheetId: number | undefined): FakeSheet {
  const sheet = file.sheets.find((candidate) => candidate.sheetId === sheetId);
  if (!sheet) throw new Error(`The E2E store has no sheet ${String(sheetId)} in "${file.id}".`);
  return sheet;
}

function applyAddSheet(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  const properties =
    read<{ properties?: { title?: string; hidden?: boolean } }>(request, "addSheet")?.properties ??
    {};
  const title = properties.title ?? `Sheet${file.sheets.length + 1}`;

  if (file.sheets.some((sheet) => sheet.title === title)) {
    throw new Error(`A sheet named "${title}" already exists.`);
  }

  const sheet = makeSheet(store.nextSheetId++, title, properties.hidden === true);
  file.sheets.push(sheet);

  return { addSheet: { sheetId: sheet.sheetId, title } };
}

function applyDeleteSheet(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const sheetId = read<{ sheetId?: number }>(request, "deleteSheet")?.sheetId;
  const index = file.sheets.findIndex((sheet) => sheet.sheetId === sheetId);
  if (index === -1) throw new Error(`The E2E store has no sheet ${String(sheetId)} to delete.`);

  file.sheets.splice(index, 1);
  return {};
}

function applyAddProtectedRange(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  const protectedRange =
    read<{ protectedRange?: { range?: { sheetId?: number }; editors?: { users?: string[] } } }>(
      request,
      "addProtectedRange",
    )?.protectedRange ?? {};

  const sheet = findSheetById(file, protectedRange.range?.sheetId);
  const protectedRangeId = store.nextProtectionId++;
  protect(sheet, protectedRangeId, protectedRange.editors?.users ?? []);

  return { addProtectedRange: { protectedRangeId } };
}

function applyUpdateSheetProperties(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const properties =
    read<{ properties?: { sheetId?: number; hidden?: boolean } }>(request, "updateSheetProperties")
      ?.properties ?? {};

  const sheet = findSheetById(file, properties.sheetId);
  if (properties.hidden !== undefined) sheet.hidden = properties.hidden;

  return {};
}

/** Real cell writes: the create flow's calendar, headers, and formulas land here. */
function applyUpdateCells(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const payload = read<{ range?: GridRangeResource; rows?: { values?: CellDataResource[] }[] }>(
    request,
    "updateCells",
  );

  const range = payload?.range ?? {};
  const sheet = findSheetById(file, range.sheetId);
  const startRow = (range.startRowIndex ?? 0) + 1;
  const startColumn = (range.startColumnIndex ?? 0) + 1;

  (payload?.rows ?? []).forEach((row, rowOffset) => {
    (row.values ?? []).forEach((cell, columnOffset) => {
      writeCell(sheet, startRow + rowOffset, startColumn + columnOffset, toCellValue(cell));
    });
  });

  return {};
}

export function applyRequest(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  if (request.addSheet !== undefined) return applyAddSheet(store, file, request);
  if (request.deleteSheet !== undefined) return applyDeleteSheet(file, request);
  if (request.addProtectedRange !== undefined) return applyAddProtectedRange(store, file, request);
  if (request.updateSheetProperties !== undefined) return applyUpdateSheetProperties(file, request);
  if (request.updateCells !== undefined) return applyUpdateCells(file, request);

  // mergeCells / repeatCell / setDataValidation are presentation only: they
  // carry no reply and no state any product rule reads back.
  return {};
}
