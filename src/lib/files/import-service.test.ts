import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET_TITLES,
  buildAttendanceWorkbookBuffer,
} from "../../../tests/fixtures/workbook";
import { createFileDependenciesFake } from "../../../tests/fakes/file-dependencies";
import { CONFIG_SHEET_TITLE } from "@/lib/config/schema";
import type { ConvertXlsxInput, DriveGateway } from "@/lib/google/types";
import { WorkbookCheckError } from "@/lib/workbook/xlsx-inspector";
import { importFileInputSchema } from "./import-schemas";
import {
  IMPORT_MEMBER_INVITE_FAILED_MESSAGE,
  ImportError,
  createImportService,
  type ImportServiceDependencies,
} from "./import-service";

const OWNER_EMAIL = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";
const CONVERTED_FILE_ID = "converted-file-1";
const FOLDER = { id: "folder-1", name: "Attendance 2026" };

const validRequest = importFileInputSchema.parse({
  fileName: "202607勤怠管理表",
  month: "2026-07",
  // A stale browser-cached folder name must never win over Drive metadata.
  destinationFolder: { id: "folder-1", name: "Stale folder name" },
  mappings: [
    { sheetTitle: "Employee A", email: "Employee-A@Blended-Asia.com" },
    { sheetTitle: "Employee B", email: "employee-b@blended-asia.com" },
  ],
});

/* -------------------------------------------------------------------------- */
/* Fake                                                                        */
/* -------------------------------------------------------------------------- */

type FileDependencies = ReturnType<typeof createFileDependenciesFake>;

interface ImportFake extends Omit<FileDependencies, "drive"> {
  drive: DriveGateway;
  /** Every `convertXlsx` call, in order. */
  uploads: ConvertXlsxInput[];
  fileId: string;
}

interface ImportFakeOptions {
  sheetTitles?: readonly string[];
  /** Adds an untrusted `__APP_CONFIG` tab to the converted workbook. */
  uploadedConfig?: boolean;
}

/**
 * Wraps the committed create-flow fake with a Drive conversion.
 *
 * Drive converts an uploaded workbook into a file that already holds the
 * workbook's tabs and their rows, so the fake pre-builds that file and hands
 * its ID back from `convertXlsx`. The pre-build is fake plumbing rather than
 * observed behaviour, so its events and request logs are cleared before the
 * service runs.
 */
async function createImportFake(options: ImportFakeOptions = {}): Promise<ImportFake> {
  const base = createFileDependenciesFake({ fileId: CONVERTED_FILE_ID });
  const titles = options.sheetTitles ?? DEFAULT_SHEET_TITLES;

  const converted = await base.drive.createSpreadsheetFile({
    name: "202607勤怠管理表",
    folderId: FOLDER.id,
  });
  const initial = await base.sheets.getSpreadsheet(converted.id);
  await base.sheets.batchUpdate(converted.id, [
    ...titles.map((title) => ({ addSheet: { properties: { title } } })),
    ...(options.uploadedConfig
      ? [{ addSheet: { properties: { title: CONFIG_SHEET_TITLE, hidden: true } } }]
      : []),
    ...initial.sheets.map((sheet) => ({ deleteSheet: { sheetId: sheet.sheetId } })),
  ]);

  base.clearEvents();
  base.addedSheetTitles.length = 0;
  base.deletedSheetIds.length = 0;
  base.gridResizes.length = 0;
  base.createdFiles.length = 0;

  const uploads: ConvertXlsxInput[] = [];
  const drive: DriveGateway = {
    ...base.drive,
    async convertXlsx(input: ConvertXlsxInput) {
      uploads.push(input);
      base.events.push(`convert-xlsx:${input.name}:${input.folderId}`);
      return { id: converted.id, name: input.name };
    },
  };

  return { ...base, drive, uploads, fileId: converted.id };
}

function dependenciesOf(fake: ImportFake): ImportServiceDependencies {
  return { drive: fake.drive, sheets: fake.sheets, config: fake.config };
}

function serviceFor(fake: ImportFake): ReturnType<typeof createImportService> {
  return createImportService(dependenciesOf(fake));
}

async function workbook(month?: string): Promise<Buffer> {
  return buildAttendanceWorkbookBuffer(month === undefined ? {} : { month });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("ImportService.importWorkbook validation", () => {
  it("inspects the workbook without any Drive or Sheets call", async () => {
    const fake = await createImportFake();

    // The workbook is July 2026; the manager confirmed August.
    const failure = await serviceFor(fake)
      .importWorkbook({
        ownerEmail: OWNER_EMAIL,
        request: { ...validRequest, month: "2026-08" },
        workbook: await workbook(),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkbookCheckError);
    expect((failure as WorkbookCheckError).code).toBe("month-mismatch");
    expect((failure as WorkbookCheckError).sheetTitle).toBe("Employee A");
    expect(fake.events).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a duplicate employee email before any Drive or Sheets call", async () => {
    const fake = await createImportFake();

    const failure = await serviceFor(fake)
      .importWorkbook({
        ownerEmail: OWNER_EMAIL,
        request: {
          ...validRequest,
          mappings: [
            { sheetTitle: "Employee A", email: EMPLOYEE_A },
            { sheetTitle: "Employee B", email: EMPLOYEE_A },
          ],
        },
        workbook: await workbook(),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImportError);
    expect((failure as ImportError).code).toBe("duplicate-member-email");
    expect(fake.events).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a mapping that does not cover every recognized sheet", async () => {
    const fake = await createImportFake();

    const failure = await serviceFor(fake)
      .importWorkbook({
        ownerEmail: OWNER_EMAIL,
        request: {
          ...validRequest,
          mappings: [{ sheetTitle: "Employee A", email: EMPLOYEE_A }],
        },
        workbook: await workbook(),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImportError);
    expect((failure as ImportError).code).toBe("sheet-mapping-mismatch");
    expect(fake.events).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a mapped sheet title the workbook does not contain", async () => {
    const fake = await createImportFake();

    const failure = await serviceFor(fake)
      .importWorkbook({
        ownerEmail: OWNER_EMAIL,
        request: {
          ...validRequest,
          mappings: [
            { sheetTitle: "Employee A", email: EMPLOYEE_A },
            { sheetTitle: "Employee C", email: EMPLOYEE_B },
          ],
        },
        workbook: await workbook(),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImportError);
    expect((failure as ImportError).code).toBe("sheet-mapping-mismatch");
    expect(fake.uploads).toEqual([]);
  });
});

describe("ImportService.importWorkbook save", () => {
  it("performs the approved import sequence in order", async () => {
    const fake = await createImportFake();

    await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    expect(fake.events).toEqual([
      "validate-folder:folder-1",
      "convert-xlsx:202607勤怠管理表:folder-1",
      "set-app-properties:pending",
      "create-config-and-employee-sheets",
      "protect-config-and-employee-sheets",
      "invite:employee-a@blended-asia.com",
      "invite:employee-b@blended-asia.com",
      "set-app-properties:ready",
    ]);
  });

  it("uploads the original bytes once, unchanged, into exactly one destination folder", async () => {
    const fake = await createImportFake();
    const buffer = await workbook();

    await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: buffer,
    });

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0].name).toBe("202607勤怠管理表");
    expect(fake.uploads[0].folderId).toBe(FOLDER.id);
    expect(Buffer.from(fake.uploads[0].content)).toEqual(buffer);
  });

  it("returns the converted file, revalidated folder, and completed member progress", async () => {
    const fake = await createImportFake();

    const result = await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    expect(result).toEqual({
      fileId: CONVERTED_FILE_ID,
      fileName: "202607勤怠管理表",
      month: "2026-07",
      folder: FOLDER,
      setupState: "ready",
      complete: true,
      retryable: false,
      members: [
        {
          displayName: "Employee A",
          email: EMPLOYEE_A,
          sheetId: "1",
          sheetTitle: "Employee A",
          protectionId: null,
          permissionId: "permission-1",
          setupStatus: "ready",
          error: null,
        },
        {
          displayName: "Employee B",
          email: EMPLOYEE_B,
          sheetId: "2",
          sheetTitle: "Employee B",
          protectionId: null,
          permissionId: "permission-2",
          setupStatus: "ready",
          error: null,
        },
      ],
    });
  });

  it("keeps the imported tabs and never resizes their populated grids", async () => {
    const fake = await createImportFake();

    await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    expect(fake.sheetTitles(CONVERTED_FILE_ID)).toEqual([
      "Employee A",
      "Employee B",
      CONFIG_SHEET_TITLE,
    ]);
    // Recreating or re-templating an imported tab would discard real rows.
    expect(fake.addedSheetTitles).toEqual([CONFIG_SHEET_TITLE]);
    expect(fake.gridResizes).toEqual([]);
  });

  it("replaces an untrusted uploaded configuration sheet with the current schema", async () => {
    const fake = await createImportFake({ uploadedConfig: true });

    await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await buildAttendanceWorkbookBuffer({ configSheetState: "hidden" }),
    });

    // The uploaded tab (id 3) is deleted and a fresh one is created.
    expect(fake.deletedSheetIds).toEqual([3]);
    expect(
      fake.sheetTitles(CONVERTED_FILE_ID).filter((title) => title === CONFIG_SHEET_TITLE),
    ).toHaveLength(1);

    const { config } = await fake.config.read(CONVERTED_FILE_ID);
    expect(config.ownerEmail).toBe(OWNER_EMAIL);
    expect(config.month).toBe("2026-07");
    expect(config.members.map((member) => member.email)).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
  });

  it("stores the manager-selected month and the verified owner identity", async () => {
    const fake = await createImportFake();

    await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    expect(fake.appProperties(CONVERTED_FILE_ID)).toEqual({
      attendanceApp: "v1",
      attendanceSetupState: "ready",
      attendanceMonth: "2026-07",
    });

    const { config } = await fake.config.read(CONVERTED_FILE_ID);
    expect(config.setupState).toBe("ready");
    expect(config.ownerEmail).toBe(OWNER_EMAIL);
    // Adopted tabs are left open; only `__APP_CONFIG` is protected.
    expect(fake.addedProtections).toEqual([{ sheetId: 3, editors: [OWNER_EMAIL] }]);
  });
});

describe("ImportService.importWorkbook partial failure", () => {
  it("retains the converted file and reports needs-repair when an invitation fails", async () => {
    const fake = await createImportFake();
    fake.failInvite(EMPLOYEE_B);

    const result = await serviceFor(fake).importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    expect(result.fileId).toBe(CONVERTED_FILE_ID);
    expect(result.folder).toEqual(FOLDER);
    expect(result.setupState).toBe("needs-repair");
    expect(result.complete).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.members.map((member) => member.setupStatus)).toEqual(["ready", "invite-failed"]);
    expect(result.members[1].error).toBe(IMPORT_MEMBER_INVITE_FAILED_MESSAGE);

    // The file is kept, never deleted as rollback.
    expect(fake.sheetTitles(CONVERTED_FILE_ID)).toContain("Employee A");
    expect(fake.appProperties(CONVERTED_FILE_ID).attendanceSetupState).toBe("needs-repair");
    const { config } = await fake.config.read(CONVERTED_FILE_ID);
    expect(config.setupState).toBe("needs-repair");
  });

  it("resumes the converted file without uploading the workbook again", async () => {
    const fake = await createImportFake();
    fake.failInvite(EMPLOYEE_B);

    const service = serviceFor(fake);
    const partial = await service.importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
    });

    fake.clearInviteFailures();
    fake.clearEvents();

    const retried = await service.importWorkbook({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      workbook: await workbook(),
      resumeFileId: partial.fileId,
    });

    expect(retried.fileId).toBe(CONVERTED_FILE_ID);
    expect(retried.setupState).toBe("ready");
    expect(retried.complete).toBe(true);
    expect(retried.retryable).toBe(false);
    expect(retried.members.map((member) => member.setupStatus)).toEqual(["ready", "ready"]);

    expect(fake.uploads).toHaveLength(1);
    expect(fake.events).toEqual([
      "validate-folder:folder-1",
      "invite:employee-b@blended-asia.com",
      "set-app-properties:ready",
    ]);
    // The completed member keeps its permission; only the failed email is retried.
    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B, EMPLOYEE_B]);
    expect(fake.addedProtections).toHaveLength(1);
  });

  it("refuses to resume a file that has no attendance configuration", async () => {
    const fake = await createImportFake();

    const failure = await serviceFor(fake)
      .importWorkbook({
        ownerEmail: OWNER_EMAIL,
        request: validRequest,
        workbook: await workbook(),
        resumeFileId: CONVERTED_FILE_ID,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImportError);
    expect((failure as ImportError).code).toBe("resume-unavailable");
    expect(fake.uploads).toEqual([]);
  });
});
