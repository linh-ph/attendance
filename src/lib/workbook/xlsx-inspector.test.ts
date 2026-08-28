import { describe, expect, it } from "vitest";
import {
  buildAttendanceWorkbookBuffer,
  buildCorruptZipBuffer,
  buildEncryptedWorkbookBuffer,
  buildMacroEnabledWorkbookBuffer,
  buildNonXlsxBuffer,
  buildOversizeBuffer,
} from "../../../tests/fixtures/workbook";
import type { WorkbookCheckCode } from "./xlsx-inspector";
import { MAX_WORKBOOK_BYTES, WorkbookCheckError, inspectXlsx } from "./xlsx-inspector";

const JULY_2026 = {
  sheets: [
    { title: "Employee A", rowCount: 31, month: "2026-07" },
    { title: "Employee B", rowCount: 31, month: "2026-07" },
  ],
};

async function captureCheckError(buffer: Buffer): Promise<WorkbookCheckError> {
  try {
    await inspectXlsx(buffer);
  } catch (error) {
    if (error instanceof WorkbookCheckError) return error;
    throw error;
  }

  throw new Error("expected inspectXlsx to reject");
}

async function expectCheck(
  buffer: Buffer,
  code: WorkbookCheckCode,
  sheetTitle: string | null,
): Promise<WorkbookCheckError> {
  const error = await captureCheckError(buffer);
  expect(error.code).toBe(code);
  expect(error.sheetTitle).toBe(sheetTitle);
  return error;
}

describe("inspectXlsx", () => {
  it("recognizes the reference attendance workbook", async () => {
    const result = await inspectXlsx(await buildAttendanceWorkbookBuffer());

    expect(result).toEqual(JULY_2026);
  });

  it("resolves date rows stored as Excel serial numbers", async () => {
    const result = await inspectXlsx(await buildAttendanceWorkbookBuffer({ dateFormat: "serial" }));

    expect(result).toEqual(JULY_2026);
  });

  it("performs no Google or filesystem work and never mutates the buffer", async () => {
    const buffer = await buildAttendanceWorkbookBuffer();
    const before = Buffer.from(buffer);

    await inspectXlsx(buffer);

    expect(buffer.equals(before)).toBe(true);
  });
});

describe("inspectXlsx auxiliary sheets", () => {
  it("ignores an existing __APP_CONFIG sheet rather than trusting it", async () => {
    const hidden = await inspectXlsx(await buildAttendanceWorkbookBuffer({ configSheetState: "hidden" }));
    const visible = await inspectXlsx(await buildAttendanceWorkbookBuffer({ configSheetState: "visible" }));

    expect(hidden).toEqual(JULY_2026);
    expect(visible).toEqual(JULY_2026);
  });

  it("blocks import when another visible sheet is present", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ auxiliarySheetTitle: "Summary" });

    await expectCheck(buffer, "unsupported-sheet", "Summary");
  });
});

describe("inspectXlsx contract checks", () => {
  it("reports missing D3:I3 headers with the sheet title", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ mutation: "break-headers" });

    await expectCheck(buffer, "missing-headers", "Employee A");
  });

  it("reports a missing hour merge", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ mutation: "break-hour-merge" });

    await expectCheck(buffer, "invalid-hour-merges", "Employee A");
  });

  it("reports an altered minute header", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ mutation: "break-minute-header" });

    await expectCheck(buffer, "invalid-minute-headers", "Employee A");
  });

  it("reports date rows that span more than one month", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ mutation: "break-month" });

    await expectCheck(buffer, "month-mismatch", "Employee A");
  });

  it("reports a column H formula that is not equivalent to F-G-E", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({ mutation: "break-work-formula" });

    await expectCheck(buffer, "invalid-work-formula", "Employee A");
  });

  it("accepts a blank column H and static values that reconcile to F-G-E", async () => {
    const blank = await buildAttendanceWorkbookBuffer({ workHours: "blank" });
    const staticValues = await buildAttendanceWorkbookBuffer({ workHours: "static-values" });

    await expect(inspectXlsx(blank)).resolves.toEqual(JULY_2026);
    await expect(inspectXlsx(staticValues)).resolves.toEqual(JULY_2026);
  });

  it("accepts a workbook for any month with the matching row count", async () => {
    const buffer = await buildAttendanceWorkbookBuffer({
      month: "2026-02",
      sheetTitles: ["Employee A"],
    });

    await expect(inspectXlsx(buffer)).resolves.toEqual({
      sheets: [{ title: "Employee A", rowCount: 28, month: "2026-02" }],
    });
  });
});

describe("inspectXlsx file guards", () => {
  it("rejects a buffer larger than the 20 MB limit before parsing", async () => {
    expect(MAX_WORKBOOK_BYTES).toBe(20 * 1024 * 1024);

    await expectCheck(buildOversizeBuffer(MAX_WORKBOOK_BYTES), "file-too-large", null);
  });

  it("rejects a file that is not an .xlsx workbook", async () => {
    await expectCheck(buildNonXlsxBuffer(), "unsupported-file", null);
  });

  it("rejects a corrupt archive", async () => {
    await expectCheck(await buildCorruptZipBuffer(), "unsupported-file", null);
  });

  it("rejects an encrypted workbook", async () => {
    await expectCheck(buildEncryptedWorkbookBuffer(), "unsupported-file", null);
  });

  it("rejects a macro-enabled workbook", async () => {
    await expectCheck(await buildMacroEnabledWorkbookBuffer(), "unsupported-file", null);
  });

  it("keeps every message safe English without parser internals", async () => {
    const buffers = [
      buildNonXlsxBuffer(),
      buildEncryptedWorkbookBuffer(),
      await buildCorruptZipBuffer(),
      await buildMacroEnabledWorkbookBuffer(),
      await buildAttendanceWorkbookBuffer({ mutation: "break-headers" }),
      await buildAttendanceWorkbookBuffer({ mutation: "break-work-formula" }),
    ];

    for (const buffer of buffers) {
      const error = await captureCheckError(buffer);
      expect(error.message).toMatch(/^[\x20-\x7E]+$/);
      expect(error.message).not.toMatch(/node_modules|\/app\/|Error:|\bat\s+\w+\.\w+/);
    }
  });
});
