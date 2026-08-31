import { describe, expect, it } from "vitest";
import { STATUS_OPTIONS } from "@/lib/attendance/model";
import { TIME_SLOTS } from "@/lib/attendance/slots";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  type AppConfig,
} from "@/lib/config/schema";
import type { SheetRequest } from "@/lib/google/types";
import {
  DATA_START_ROW,
  HEADER_CELLS,
  HEADER_ROW,
  HOUR_HEADER_ROW,
  REFERENCE_COLUMN_BY_KEY,
  WORK_REPORT_HEADER,
} from "./contract";
import {
  MAX_SHEET_TITLE_LENGTH,
  SheetTitleError,
  buildConfigSheetPlan,
  buildEmployeeSheetPlan,
  buildEmployeeSheetTitle,
  buildEmployeeSheetTitles,
  isSheetTitleError,
} from "./template";

const SHEET_ID = 1234567;
const MONTH = "2026-07";

/** July 2026 starts on a Wednesday and has 23 Monday-Friday business days. */
const JULY_2026_DAYS = 31;
const JULY_2026_BUSINESS_DAYS = 23;

function plan() {
  return buildEmployeeSheetPlan({ sheetId: SHEET_ID, month: MONTH });
}

function requestsOfKind(requests: readonly SheetRequest[], kind: string): SheetRequest[] {
  return requests.filter((request) => Object.hasOwn(request, kind));
}

interface GridRangeLike {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

function rangeOf(request: SheetRequest, kind: string): GridRangeLike {
  const payload = request[kind] as { range: GridRangeLike };
  return payload.range;
}

describe("buildEmployeeSheetPlan month grid", () => {
  it("produces one row per calendar day starting at the data start row", () => {
    const template = plan();

    expect(template.rows).toHaveLength(JULY_2026_DAYS);
    expect(template.rows.at(0)?.row).toBe(DATA_START_ROW);
    expect(template.rows.at(0)?.row).toBe(4);
    expect(template.rows.at(-1)?.row).toBe(DATA_START_ROW + JULY_2026_DAYS - 1);
  });

  it("puts each calendar date of the month in column A", () => {
    const template = plan();

    expect(template.rows.map((row) => row.date).at(0)).toBe("2026-07-01");
    expect(template.rows.map((row) => row.date).at(-1)).toBe("2026-07-31");
    expect(new Set(template.rows.map((row) => row.date)).size).toBe(JULY_2026_DAYS);
    expect(REFERENCE_COLUMN_BY_KEY.date.letter).toBe("A");
  });

  it("displays the weekday in column B", () => {
    const template = plan();

    expect(REFERENCE_COLUMN_BY_KEY.weekday.letter).toBe("B");
    expect(template.rows.at(0)?.weekday).toBe("水");
    expect(template.rows.at(3)?.weekday).toBe("土");
    expect(template.rows.at(4)?.weekday).toBe("日");
  });

  it("increments column C Monday-Friday and leaves it blank on Saturday and Sunday", () => {
    const template = plan();
    const businessRows = template.rows.filter((row) => row.isBusinessDay);

    expect(REFERENCE_COLUMN_BY_KEY.businessDay.letter).toBe("C");
    expect(businessRows).toHaveLength(JULY_2026_BUSINESS_DAYS);
    expect(businessRows.map((row) => row.businessDay)).toEqual(
      Array.from({ length: JULY_2026_BUSINESS_DAYS }, (_value, index) => index + 1),
    );
    // 2026-07-04 is a Saturday and 2026-07-05 is a Sunday.
    expect(template.rows.at(3)?.businessDay).toBeNull();
    expect(template.rows.at(4)?.businessDay).toBeNull();
    expect(template.rows.at(3)?.isBusinessDay).toBe(false);
    expect(template.rows.at(5)?.businessDay).toBe(4);
  });

  it("carries the =F-G-E row formula in column H on business days only", () => {
    const template = plan();

    expect(REFERENCE_COLUMN_BY_KEY.workHours.letter).toBe("H");
    expect(template.rows.at(0)?.workHoursFormula).toBe("=F4-G4-E4");
    expect(template.rows.at(2)?.workHoursFormula).toBe("=F6-G6-E6");
    expect(template.rows.at(3)?.workHoursFormula).toBeNull();
    expect(template.rows.at(4)?.workHoursFormula).toBeNull();
  });

  it("rejects a month that is not YYYY-MM", () => {
    expect(() => buildEmployeeSheetPlan({ sheetId: SHEET_ID, month: "2026-13" })).toThrow("invalid-month");
    expect(() => buildEmployeeSheetPlan({ sheetId: SHEET_ID, month: "202607" })).toThrow("invalid-month");
  });
});

describe("buildEmployeeSheetPlan work-report header contract", () => {
  it("exposes exactly 36 work columns spanning J:AS", () => {
    const template = plan();

    expect(template.workColumns).toHaveLength(36);
    expect(template.workColumns).toHaveLength(TIME_SLOTS.length);
    expect(template.workColumns.at(0)?.letter).toBe("J");
    expect(template.workColumns.at(-1)?.letter).toBe("AS");
    expect(template.workReportHeader).toEqual({
      range: `J1:AS1`,
      value: WORK_REPORT_HEADER,
    });
  });

  it("matches the plan hour merge, minute header, and frozen pane expectations", () => {
    const template = plan();

    expect(template.hourMerges.at(0)).toEqual({ range: "J2:K2", value: 6 });
    expect(template.hourMerges.at(-1)).toEqual({ range: "AR2:AS2", value: 23 });
    expect(template.minuteHeaders.slice(0, 4)).toEqual([0, 30, 0, 30]);
    expect(template.minuteHeaders).toHaveLength(36);
    expect(template.frozenPane).toEqual({ rows: 3, columns: 2 });
  });

  it("writes the Japanese sheet headers on the header row", () => {
    const template = plan();

    expect(template.headerCells.map((cell) => cell.cell)).toEqual([
      "D3",
      "E3",
      "F3",
      "G3",
      "H3",
      "I3",
    ]);
    expect(template.headerCells.map((cell) => cell.value)).toEqual([
      "ステータス",
      "出勤",
      "退勤",
      "休憩",
      "労働時間",
      "備考",
    ]);
    expect(HEADER_CELLS).toEqual(template.headerCells);
    expect(HEADER_ROW).toBe(3);
    expect(HOUR_HEADER_ROW).toBe(2);
  });
});

describe("buildEmployeeSheetPlan batch requests", () => {
  it("addresses the numeric sheet id in every request range", () => {
    const template = plan();

    expect(template.sheetId).toBe(SHEET_ID);
    expect(template.requests.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(template.requests);
    expect(serialized).not.toContain("title");
    for (const sheetId of serialized.matchAll(/"sheetId":(\d+)/g)) {
      expect(Number(sheetId[1])).toBe(SHEET_ID);
    }
  });

  /*
   * Read off the supplied `202607勤怠管理表` workbook, so a created tab is
   * recognisable as the same document. That workbook uses no fills and no
   * borders, so neither is invented here.
   */
  it("sets Arial across the sheet, naming only the font in fields", () => {
    const template = plan();
    const font = requestsOfKind(template.requests, "repeatCell").find((request) =>
      JSON.stringify(request).includes("fontFamily"),
    );

    expect(font).toBeDefined();
    expect(font?.repeatCell).toMatchObject({
      cell: { userEnteredFormat: { textFormat: { fontFamily: "Arial" } } },
      fields: "userEnteredFormat.textFormat.fontFamily",
    });
  });

  it("gives every column the reference workbook's width", () => {
    const template = plan();
    const widths = requestsOfKind(template.requests, "updateDimensionProperties").map(
      (request) =>
        request.updateDimensionProperties as {
          range: { dimension: string; startIndex: number; endIndex: number };
          properties: { pixelSize: number };
        },
    );

    expect(widths.every((width) => width.range.dimension === "COLUMNS")).toBe(true);
    // A is the date column; J:AS are the 36 half-hour slots, sized as one run.
    expect(widths[0]).toMatchObject({
      range: { startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 65 },
    });
    expect(widths.at(-1)).toMatchObject({
      range: { startIndex: 9, endIndex: 45 },
      properties: { pixelSize: 34 },
    });
    expect(widths).toHaveLength(8);
  });

  it("freezes the first three rows and the first two columns", () => {
    const template = plan();
    const [freeze] = requestsOfKind(template.requests, "updateSheetProperties");
    const properties = (freeze.updateSheetProperties as {
      properties: { sheetId: number; gridProperties: Record<string, number> };
    }).properties;

    expect(properties.sheetId).toBe(SHEET_ID);
    expect(properties.gridProperties.frozenRowCount).toBe(3);
    expect(properties.gridProperties.frozenColumnCount).toBe(2);
  });

  it("merges the work-report banner and every hour header pair", () => {
    const template = plan();
    const merges = requestsOfKind(template.requests, "mergeCells");

    expect(merges).toHaveLength(1 + template.hourMerges.length);
    expect(rangeOf(merges[0], "mergeCells")).toEqual({
      sheetId: SHEET_ID,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 9,
      endColumnIndex: 45,
    });
    expect(rangeOf(merges[1], "mergeCells")).toEqual({
      sheetId: SHEET_ID,
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 9,
      endColumnIndex: 11,
    });
  });

  it("fills column H with formulas instead of calculated work values", () => {
    const template = plan();
    const workHoursColumnIndex = REFERENCE_COLUMN_BY_KEY.workHours.index - 1;
    const [request] = requestsOfKind(template.requests, "updateCells").filter((candidate) => {
      const range = rangeOf(candidate, "updateCells");
      return range.startColumnIndex === workHoursColumnIndex && range.startRowIndex >= DATA_START_ROW - 1;
    });

    expect(request).toBeDefined();
    const payload = request.updateCells as {
      range: GridRangeLike;
      rows: { values: { userEnteredValue?: Record<string, unknown> }[] }[];
    };

    expect(payload.rows).toHaveLength(template.rows.length);
    payload.rows.forEach((row, index) => {
      const value = row.values[0].userEnteredValue ?? {};
      expect(value).not.toHaveProperty("numberValue");
      expect(Object.hasOwn(value, "formulaValue") ? value.formulaValue : null).toBe(
        template.rows[index].workHoursFormula,
      );
    });

    expect(JSON.stringify(template.requests)).toContain("=F4-G4-E4");
    expect(JSON.stringify(template.requests)).toContain("=F34-G34-E34");
  });

  it("leaves attendance input cells blank in the data rows", () => {
    const template = plan();
    const inputColumns = new Set<number>([3, 4, 5, 6, 8]);
    for (const column of template.workColumns) inputColumns.add(column.index - 1);

    for (const request of requestsOfKind(template.requests, "updateCells")) {
      const payload = request.updateCells as {
        range: GridRangeLike;
        rows: { values: { userEnteredValue?: Record<string, unknown> }[] }[];
      };
      if (payload.range.startRowIndex < DATA_START_ROW - 1) continue;

      for (const row of payload.rows) {
        row.values.forEach((cell, offset) => {
          const columnIndex = payload.range.startColumnIndex + offset;
          if (!inputColumns.has(columnIndex)) return;
          expect(cell.userEnteredValue ?? {}).toEqual({});
        });
      }
    }
  });

  it("applies the configured status list validation to business-day D cells only", () => {
    const template = plan();
    const validations = requestsOfKind(template.requests, "setDataValidation");

    expect(validations.length).toBeGreaterThan(0);
    expect(template.statuses).toEqual(STATUS_OPTIONS.map((status) => ({ ...status })));

    const validatedRows: number[] = [];
    for (const request of validations) {
      const payload = request.setDataValidation as {
        range: GridRangeLike;
        rule: {
          condition: { type: string; values: { userEnteredValue: string }[] };
          strict: boolean;
          showCustomUi: boolean;
        };
      };

      expect(payload.range.startColumnIndex).toBe(3);
      expect(payload.range.endColumnIndex).toBe(4);
      expect(payload.rule.strict).toBe(true);
      expect(payload.rule.showCustomUi).toBe(true);
      expect(payload.rule.condition.type).toBe("ONE_OF_LIST");
      expect(payload.rule.condition.values.map((value) => value.userEnteredValue)).toEqual([
        "出社",
        "欠勤",
      ]);

      for (let index = payload.range.startRowIndex; index < payload.range.endRowIndex; index += 1) {
        validatedRows.push(index + 1);
      }
    }

    expect(validatedRows).toEqual(
      template.rows.filter((row) => row.isBusinessDay).map((row) => row.row),
    );
  });

  it("formats the decimal-hour columns E:H as plain numbers, never as time fractions", () => {
    const template = plan();
    const formats = requestsOfKind(template.requests, "repeatCell");
    const decimalFormat = formats.find((request) => {
      const range = rangeOf(request, "repeatCell");
      return range.startColumnIndex === 4 && range.endColumnIndex === 8;
    });

    expect(decimalFormat).toBeDefined();
    const payload = decimalFormat?.repeatCell as {
      cell: { userEnteredFormat: { numberFormat: { type: string; pattern: string } } };
      fields: string;
    };

    expect(payload.cell.userEnteredFormat.numberFormat.type).toBe("NUMBER");
    expect(payload.cell.userEnteredFormat.numberFormat.type).not.toBe("TIME");
    expect(payload.cell.userEnteredFormat.numberFormat.type).not.toBe("DATE_TIME");
    expect(payload.fields).toBe("userEnteredFormat.numberFormat");
  });
});

describe("employee sheet titles", () => {
  it("uses the trimmed display name", () => {
    expect(buildEmployeeSheetTitle("  Employee A  ")).toBe("Employee A");
    expect(buildEmployeeSheetTitles(["  Employee A ", "Employee B"])).toEqual([
      "Employee A",
      "Employee B",
    ]);
  });

  it("rejects an empty title", () => {
    expect(() => buildEmployeeSheetTitle("   ")).toThrow(SheetTitleError);
    try {
      buildEmployeeSheetTitle("");
    } catch (error) {
      expect(isSheetTitleError(error)).toBe(true);
      expect(isSheetTitleError(error) && error.code).toBe("empty-title");
    }
  });

  it("rejects a title that duplicates another after normalization", () => {
    expect(() => buildEmployeeSheetTitles(["Employee A", " Employee A "])).toThrow(SheetTitleError);
    expect(() => buildEmployeeSheetTitles(["Employee A", "employee a"])).toThrow(SheetTitleError);
    try {
      buildEmployeeSheetTitles(["Employee A", "employee a"]);
    } catch (error) {
      expect(isSheetTitleError(error) && error.code).toBe("duplicate-title");
    }
  });

  it("rejects a title longer than 100 characters", () => {
    expect(MAX_SHEET_TITLE_LENGTH).toBe(100);
    expect(buildEmployeeSheetTitle("a".repeat(MAX_SHEET_TITLE_LENGTH))).toHaveLength(100);
    expect(() => buildEmployeeSheetTitle("a".repeat(MAX_SHEET_TITLE_LENGTH + 1))).toThrow(
      SheetTitleError,
    );
    try {
      buildEmployeeSheetTitle("a".repeat(101));
    } catch (error) {
      expect(isSheetTitleError(error) && error.code).toBe("title-too-long");
    }
  });

  it("rejects a title containing a reserved Google Sheets character", () => {
    for (const character of [":", "\\", "/", "?", "*", "[", "]"]) {
      expect(() => buildEmployeeSheetTitle(`Employee${character}A`)).toThrow(SheetTitleError);
    }

    try {
      buildEmployeeSheetTitle("Employee[A]");
    } catch (error) {
      expect(isSheetTitleError(error) && error.code).toBe("invalid-title-character");
    }
  });

  it("never uses the reserved configuration sheet title", () => {
    expect(() => buildEmployeeSheetTitle(CONFIG_SHEET_TITLE)).toThrow(SheetTitleError);
  });
});

describe("buildConfigSheetPlan", () => {
  const config: AppConfig = {
    schemaVersion: 1,
    setupState: "pending",
    month: MONTH,
    ownerEmail: "manager@blended-asia.com",
    templateVersion: 1,
    statuses: STATUS_OPTIONS.map((status) => ({ ...status })),
    members: [
      {
        displayName: "Employee A",
        email: "employee-a@blended-asia.com",
        sheetId: null,
        sheetTitle: null,
        protectionId: null,
        permissionId: null,
        setupStatus: "pending",
      },
    ],
  };

  it("writes only the reserved configuration coordinates", () => {
    const configPlan = buildConfigSheetPlan({ sheetId: 99, config });

    expect(configPlan.title).toBe(CONFIG_SHEET_TITLE);
    expect(configPlan.sheetId).toBe(99);
    expect(configPlan.patches.map((patch) => patch.range)).toEqual([
      CONFIG_SETTINGS_RANGE,
      CONFIG_STATUS_RANGE,
      CONFIG_MEMBER_RANGE,
    ]);
    expect(configPlan.patches.at(0)?.values).toEqual([
      ["schemaVersion", "1"],
      ["setupState", "pending"],
      ["month", "2026-07"],
      ["ownerEmail", "manager@blended-asia.com"],
      ["templateVersion", "1"],
    ]);
    expect(configPlan.patches.at(1)?.values.at(0)).toEqual(["code", "labelEn", "sheetValue"]);
    expect(configPlan.patches.at(2)?.values.at(0)?.at(0)).toBe("displayName");
  });

  it("hides the configuration sheet by numeric sheet id", () => {
    const configPlan = buildConfigSheetPlan({ sheetId: 99, config });
    const [hide] = configPlan.requests;

    expect(hide.updateSheetProperties).toEqual({
      properties: { sheetId: 99, hidden: true },
      fields: "hidden",
    });
  });
});
