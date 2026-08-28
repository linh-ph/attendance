import { readFile } from "node:fs/promises";
import { Workbook } from "exceljs";
import type { Cell, Worksheet } from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DATA_START_ROW,
  HEADER_CELLS,
  HEADER_RANGE,
  HEADER_ROW,
  HOUR_HEADER_ROW,
  HOUR_MERGES,
  MINUTE_HEADERS,
  WORK_REPORT_HEADER,
  WORK_SLOT_COLUMNS,
  WORK_SLOT_FIRST_COLUMN,
  WORK_SLOT_LAST_COLUMN,
  buildWorkHoursFormula,
  toColumnLetter,
  REFERENCE_COLUMN_BY_KEY,
} from "@/lib/workbook/contract";
import { inspectXlsx } from "@/lib/workbook/xlsx-inspector";

/**
 * Optional proof against the real workbook supplied with the product request.
 *
 * The file is not committed to this repository, so the suite runs only when
 * `REFERENCE_XLSX_PATH` points at a readable copy, for example:
 *
 * ```bash
 * docker compose run --rm \
 *   -v "/absolute/path/to/202607勤怠管理表.xlsx:/ref.xlsx:ro" \
 *   --env REFERENCE_XLSX_PATH=/ref.xlsx \
 *   test npm test -- tests/reference-workbook.test.ts
 * ```
 *
 * That command collects this file only once the `include` list in
 * `vitest.config.ts` covers test files under `tests/`.
 *
 * Every assertion here reads the workbook. Nothing in this file writes it.
 */
const referencePath = process.env.REFERENCE_XLSX_PATH;

/** Sheet titles observed in the supplied `202607勤怠管理表.xlsx`, in workbook order. */
const EXPECTED_SHEET_TITLES = [
  "THAI GIA HAN",
  "NGUYEN PHAN LINH",
  "NGUYEN THI NHU HIEU",
  "NGUYEN HO TRONG THAO",
] as const;

const EXPECTED_MONTH = "2026-07";
const EXPECTED_DATE_ROWS = 31;

const CLOCK_IN_COLUMN = REFERENCE_COLUMN_BY_KEY.clockIn.letter;
const CLOCK_OUT_COLUMN = REFERENCE_COLUMN_BY_KEY.clockOut.letter;
const WORK_HOURS_COLUMN = REFERENCE_COLUMN_BY_KEY.workHours.letter;
const FIRST_UNUSED_SLOT_COLUMN = toColumnLetter(
  WORK_SLOT_COLUMNS[WORK_SLOT_COLUMNS.length - 1].index + 1,
);

function readText(cell: Cell): string {
  const value = cell.value;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function normalizeFormula(formula: string): string {
  return formula.replace(/[\s$]/g, "").toUpperCase();
}

describe.skipIf(!referencePath)("supplied reference workbook", () => {
  let bytes: Uint8Array;
  let workbook: Workbook;

  beforeAll(async () => {
    bytes = await readFile(referencePath as string);
    workbook = new Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<Workbook["xlsx"]["load"]>[0]);
  });

  function requireSheet(title: string): Worksheet {
    const worksheet = workbook.getWorksheet(title);
    if (!worksheet) throw new Error(`the reference workbook has no sheet named ${title}`);
    return worksheet;
  }

  it("inspects as four employee sheets covering July 2026", async () => {
    const inspection = await inspectXlsx(bytes);

    expect(inspection.sheets.map((sheet) => sheet.title)).toEqual([...EXPECTED_SHEET_TITLES]);
    for (const sheet of inspection.sheets) {
      expect(sheet.month).toBe(EXPECTED_MONTH);
      expect(sheet.rowCount).toBe(EXPECTED_DATE_ROWS);
    }
  });

  it.each(EXPECTED_SHEET_TITLES)("carries the D:I headers on %s", (title) => {
    const worksheet = requireSheet(title);

    expect(HEADER_RANGE).toBe("D3:I3");
    expect(HEADER_CELLS.map((header) => readText(worksheet.getCell(header.cell)))).toEqual(
      HEADER_CELLS.map((header) => header.value),
    );
  });

  it.each(EXPECTED_SHEET_TITLES)("carries the J:AS 30-minute grid on %s", (title) => {
    const worksheet = requireSheet(title);

    expect(`${WORK_SLOT_FIRST_COLUMN}:${WORK_SLOT_LAST_COLUMN}`).toBe("J:AS");
    expect(WORK_SLOT_COLUMNS).toHaveLength(36);
    expect(readText(worksheet.getCell(`${WORK_SLOT_FIRST_COLUMN}1`))).toBe(WORK_REPORT_HEADER);

    const merges = new Set(
      (worksheet.model.merges ?? []).map((range) => range.replace(/\$/g, "").toUpperCase()),
    );
    for (const merge of HOUR_MERGES) {
      expect(merges).toContain(merge.range);
      expect(worksheet.getCell(merge.range.split(":")[0]).value).toBe(merge.value);
    }
    expect(worksheet.getCell(`${WORK_SLOT_FIRST_COLUMN}${HOUR_HEADER_ROW}`).value).toBe(6);
    expect(worksheet.getCell(`${WORK_SLOT_LAST_COLUMN}${HOUR_HEADER_ROW}`).value).toBe(23);

    expect(
      WORK_SLOT_COLUMNS.map((column) => worksheet.getCell(`${column.letter}${HEADER_ROW}`).value),
    ).toEqual([...MINUTE_HEADERS]);
    expect(worksheet.getCell(`${FIRST_UNUSED_SLOT_COLUMN}${HEADER_ROW}`).value).toBeNull();
  });

  it.each(EXPECTED_SHEET_TITLES)("reconciles column H on %s", (title) => {
    const worksheet = requireSheet(title);
    const lastRow = DATA_START_ROW + EXPECTED_DATE_ROWS - 1;
    let formulaRows = 0;

    for (let row = DATA_START_ROW; row <= lastRow; row += 1) {
      const cell = worksheet.getCell(`${WORK_HOURS_COLUMN}${row}`);

      // Non-business days leave the clock columns and column H empty; every
      // other row carries the shared `=F-G-E` work-hour formula.
      if (typeof cell.formula !== "string") {
        expect(cell.value).toBeNull();
        expect(worksheet.getCell(`${CLOCK_IN_COLUMN}${row}`).value).toBeNull();
        expect(worksheet.getCell(`${CLOCK_OUT_COLUMN}${row}`).value).toBeNull();
        continue;
      }

      expect(normalizeFormula(cell.formula)).toBe(buildWorkHoursFormula(row));
      formulaRows += 1;
    }

    expect(formulaRows).toBeGreaterThanOrEqual(21);
    expect(worksheet.getCell(`${WORK_HOURS_COLUMN}${lastRow + 1}`).formula).toBeUndefined();
  });
});
