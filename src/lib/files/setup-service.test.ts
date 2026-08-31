import { describe, expect, it } from "vitest";
import { createFileDependenciesFake } from "../../../tests/fakes/file-dependencies";
import { AccessError, ForbiddenError } from "@/lib/access/policy";
import { CONFIG_SHEET_TITLE } from "@/lib/config/schema";
import type { DriveGateway } from "@/lib/google/types";
import { createFileInputSchema } from "./schemas";
import {
  LegacySetupError,
  MEMBER_INVITE_FAILED_MESSAGE,
  SetupError,
  createSetupService,
  type ConfigureExistingFileInput,
  type SetupServiceDependencies,
} from "./setup-service";

const OWNER_EMAIL = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";

const validRequest = createFileInputSchema.parse({
  fileName: "202607勤怠管理表",
  month: "2026-07",
  // A stale browser-cached folder name must never win over Drive metadata.
  destinationFolder: { id: "folder-1", name: "Stale folder name" },
  members: [
    { displayName: "Employee A", email: "Employee-A@Blended-Asia.com" },
    { displayName: "Employee B", email: "employee-b@blended-asia.com" },
  ],
});

function serviceFor(fake: FileDependencies): ReturnType<typeof createSetupService> {
  return createSetupService(dependenciesOf(fake));
}

type FileDependencies = ReturnType<typeof createFileDependenciesFake>;

function dependenciesOf(fake: FileDependencies): SetupServiceDependencies {
  return { drive: fake.drive, sheets: fake.sheets, config: fake.config };
}

describe("SetupService.create", () => {
  it("performs the approved create sequence in order for two unique members", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    expect(fake.events).toEqual([
      "validate-folder:folder-1",
      "create-drive-file:202607勤怠管理表:folder-1",
      "set-app-properties:pending",
      "create-config-and-employee-sheets",
      "protect-config-and-employee-sheets",
      "invite:employee-a@blended-asia.com",
      "invite:employee-b@blended-asia.com",
      "set-app-properties:ready",
    ]);
  });

  it("returns the created file, revalidated folder, and completed member progress", async () => {
    const fake = createFileDependenciesFake();

    const result = await serviceFor(fake).create({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
    });

    expect(result).toEqual({
      fileId: "file-1",
      fileName: "202607勤怠管理表",
      month: "2026-07",
      folder: { id: "folder-1", name: "Attendance 2026" },
      setupState: "ready",
      complete: true,
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

  it("leaves the workbook holding only the employee tabs and the hidden config tab", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    expect(fake.sheetTitles()).toEqual(["Employee A", "Employee B", CONFIG_SHEET_TITLE]);
    expect(fake.deletedSheetIds).toEqual([0]);
    expect(fake.appProperties()).toEqual({
      attendanceApp: "v1",
      attendanceSetupState: "ready",
      attendanceMonth: "2026-07",
    });
  });

  it("stores the verified owner identity and every member mapping in the config sheet", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });
    const { config } = await fake.config.read("file-1");

    expect(config.ownerEmail).toBe(OWNER_EMAIL);
    expect(config.month).toBe("2026-07");
    expect(config.setupState).toBe("ready");
    expect(config.members.map((member) => member.email)).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
    expect(config.members.every((member) => member.setupStatus === "ready")).toBe(true);
    expect(config.statuses.map((status) => status.sheetValue)).toEqual(["出社", "欠勤"]);
  });

  /*
   * Employee tabs are created open. Only the hidden `__APP_CONFIG` sheet keeps
   * its owner-only protection, because it is app metadata rather than anybody's
   * timesheet.
   */
  it("protects the configuration sheet and leaves every employee tab open", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    expect(fake.addedProtections).toEqual([{ sheetId: 3, editors: [OWNER_EMAIL] }]);
  });

  it("asks Drive to email every member by default", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
    expect(fake.invitationNotices).toEqual([true, true]);
  });

  it("shares with every member and emails nobody when invitations are declined", async () => {
    const fake = createFileDependenciesFake();
    const silent = createFileInputSchema.parse({ ...validRequest, sendInvitations: false });

    const result = await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: silent });

    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
    expect(fake.invitationNotices).toEqual([false, false]);
    expect(result.complete).toBe(true);
  });

  it("rejects duplicate member emails before any Google mutation", async () => {
    const fake = createFileDependenciesFake();

    const duplicated = createFileInputSchema.parse({
      ...validRequest,
      members: [
        { displayName: "Employee A", email: "employee-a@blended-asia.com" },
        { displayName: "Employee A duplicate", email: "Employee-A@Blended-Asia.com" },
      ],
    });

    const error = await serviceFor(fake)
      .create({ ownerEmail: OWNER_EMAIL, request: duplicated })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({ code: "duplicate-member-email" });
    expect(fake.events).toEqual([]);
    expect(fake.createdFiles).toEqual([]);
  });

  it("rejects duplicate sheet titles before any Google mutation", async () => {
    const fake = createFileDependenciesFake();

    const duplicated = createFileInputSchema.parse({
      ...validRequest,
      members: [
        { displayName: "Employee A", email: "employee-a@blended-asia.com" },
        { displayName: " employee a ", email: "employee-b@blended-asia.com" },
      ],
    });

    await expect(
      serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: duplicated }),
    ).rejects.toMatchObject({ name: "SheetTitleError", code: "duplicate-title" });

    expect(fake.events).toEqual([]);
    expect(fake.createdFiles).toEqual([]);
  });

  it("serializes invitations instead of issuing them concurrently", async () => {
    const fake = createFileDependenciesFake();
    let active = 0;
    let peak = 0;

    const drive: DriveGateway = {
      ...fake.drive,
      async createWriterPermission(fileId, email) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await Promise.resolve();
          return await fake.drive.createWriterPermission(fileId, email, true);
        } finally {
          active -= 1;
        }
      },
    };

    await createSetupService({ ...dependenciesOf(fake), drive }).create({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
    });

    expect(peak).toBe(1);
    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
  });

  it("retains the file, folder, and member progress when an invitation fails", async () => {
    const fake = createFileDependenciesFake();
    fake.failInvite(EMPLOYEE_B, new Error("Drive rejected sharing for quota-user-42."));

    const result = await serviceFor(fake).create({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
    });

    expect(result.complete).toBe(false);
    expect(result.fileId).toBe("file-1");
    expect(result.folder).toEqual({ id: "folder-1", name: "Attendance 2026" });
    expect(result.setupState).toBe("pending");

    expect(result.members[0]).toMatchObject({
      email: EMPLOYEE_A,
      sheetId: "1",
      protectionId: null,
      permissionId: "permission-1",
      setupStatus: "ready",
      error: null,
    });
    expect(result.members[1]).toMatchObject({
      email: EMPLOYEE_B,
      sheetId: "2",
      protectionId: null,
      permissionId: null,
      setupStatus: "invite-failed",
      error: MEMBER_INVITE_FAILED_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("quota-user-42");

    expect(fake.events.at(-1)).toBe("invite:employee-b@blended-asia.com");
    expect(fake.appProperties().attendanceSetupState).toBe("pending");
  });

  it("keeps inviting the remaining members after one invitation fails", async () => {
    const fake = createFileDependenciesFake();
    fake.failInvite(EMPLOYEE_A);

    const result = await serviceFor(fake).create({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
    });

    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
    expect(result.members.map((member) => member.setupStatus)).toEqual([
      "invite-failed",
      "ready",
    ]);
  });

  it("resumes a failed setup without recreating the file, tabs, or protections", async () => {
    const fake = createFileDependenciesFake();
    fake.failInvite(EMPLOYEE_B);

    const service = serviceFor(fake);
    const partial = await service.create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    const createdTitles = [...fake.addedSheetTitles];
    const protections = [...fake.addedProtections];
    const resizes = [...fake.gridResizes];

    fake.clearInviteFailures();
    fake.clearEvents();

    const resumed = await service.create({
      ownerEmail: OWNER_EMAIL,
      request: validRequest,
      resumeFileId: partial.fileId,
    });

    expect(fake.events).toEqual([
      "validate-folder:folder-1",
      "invite:employee-b@blended-asia.com",
      "set-app-properties:ready",
    ]);

    expect(fake.createdFiles).toHaveLength(1);
    expect(fake.addedSheetTitles).toEqual(createdTitles);
    expect(fake.addedProtections).toEqual(protections);
    // Replaying the template would shrink a populated tab back to the month grid.
    expect(fake.gridResizes).toEqual(resizes);
    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B, EMPLOYEE_B]);

    expect(resumed.complete).toBe(true);
    expect(resumed.fileId).toBe(partial.fileId);
    expect(resumed.setupState).toBe("ready");
    expect(resumed.members.map((member) => member.setupStatus)).toEqual(["ready", "ready"]);
    expect(resumed.members[1].permissionId).not.toBeNull();
  });

  it("refuses to resume a file that has no attendance configuration", async () => {
    const fake = createFileDependenciesFake();
    await fake.drive.createSpreadsheetFile({ name: "202607勤怠管理表", folderId: "folder-1" });
    fake.clearEvents();

    const error = await serviceFor(fake)
      .create({ ownerEmail: OWNER_EMAIL, request: validRequest, resumeFileId: "file-1" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SetupError);
    expect(error).toMatchObject({ code: "resume-unavailable" });
    expect(fake.addedSheetTitles).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Legacy file setup                                                           */
/* -------------------------------------------------------------------------- */

const LEGACY_FILE_ID = "file-1";
const LEGACY_FILE_NAME = "202607勤怠管理表";
const SHEET_A = "従業員A";
const SHEET_B = "従業員B";

interface LegacyFileOptions {
  titles?: string[];
  withUntrustedConfig?: boolean;
}

/**
 * Builds a legacy attendance workbook: employee tabs that already hold real
 * data and, optionally, an untrusted `__APP_CONFIG` tab this app did not write.
 */
async function seedLegacyFile(
  fake: FileDependencies,
  options: LegacyFileOptions = {},
): Promise<Map<string, number>> {
  const titles = options.titles ?? [SHEET_A, SHEET_B];

  await fake.drive.createSpreadsheetFile({ name: LEGACY_FILE_NAME, folderId: "folder-1" });
  await fake.sheets.batchUpdate(LEGACY_FILE_ID, [
    ...titles.map((title) => ({ addSheet: { properties: { title } } })),
    ...(options.withUntrustedConfig
      ? [{ addSheet: { properties: { title: CONFIG_SHEET_TITLE } } }]
      : []),
    { deleteSheet: { sheetId: 0 } },
  ]);

  // Real attendance rows a replayed template would truncate.
  await fake.sheets.updateValues(LEGACY_FILE_ID, [
    { range: `${titles[0]}!A4`, values: [["2026-07-01"]] },
  ]);

  const snapshot = await fake.sheets.getSpreadsheet(LEGACY_FILE_ID);

  // The workbook now looks like a file this app never touched, so every later
  // assertion sees only what legacy setup itself did.
  fake.clearEvents();
  fake.addedSheetTitles.length = 0;
  fake.addedProtections.length = 0;
  fake.deletedSheetIds.length = 0;
  fake.gridResizes.length = 0;

  return new Map(snapshot.sheets.map((sheet) => [sheet.title, sheet.sheetId]));
}

/**
 * Drive metadata for the legacy file. The fake models an app-created file, so
 * the current owner and the folder listing are supplied here instead.
 */
function legacyDrive(
  fake: FileDependencies,
  overrides: { ownerEmail?: string | null; ownedByMe?: boolean; name?: string; inFolder?: boolean } = {},
): DriveGateway {
  const ownerEmail = overrides.ownerEmail === undefined ? OWNER_EMAIL : overrides.ownerEmail;
  const ownedByMe = overrides.ownedByMe ?? true;
  const name = overrides.name ?? LEGACY_FILE_NAME;
  const inFolder = overrides.inFolder ?? true;

  return {
    ...fake.drive,
    async getFileAccess(fileId: string) {
      return { ...(await fake.drive.getFileAccess(fileId)), name, ownedByMe, ownerEmail };
    },
    async listManagerFiles() {
      return inFolder
        ? [
            {
              id: LEGACY_FILE_ID,
              name,
              ownedByMe,
              sharedWithMe: false,
              ownerEmail,
              appProperties: {},
              modifiedTime: "2026-07-01T00:00:00.000Z",
            },
          ]
        : [];
    },
  };
}

function legacyService(
  fake: FileDependencies,
  drive: DriveGateway = legacyDrive(fake),
): ReturnType<typeof createSetupService> {
  return createSetupService({ ...dependenciesOf(fake), drive });
}

function legacyRequest(
  sheetIds: Map<string, number>,
  overrides: Partial<ConfigureExistingFileInput> = {},
): ConfigureExistingFileInput {
  return {
    ownerEmail: OWNER_EMAIL,
    fileId: LEGACY_FILE_ID,
    folderId: "folder-1",
    month: "2026-07",
    mappings: [
      { sheetId: String(sheetIds.get(SHEET_A)), displayName: "Employee A", email: "Employee-A@Blended-Asia.com" },
      { sheetId: String(sheetIds.get(SHEET_B)), displayName: "Employee B", email: EMPLOYEE_B },
    ],
    ...overrides,
  };
}

describe("SetupService.inspectExisting", () => {
  it("reads the non-configuration sheets without mutating the file", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake, { withUntrustedConfig: true });

    const inspection = await legacyService(fake).inspectExisting({
      ownerEmail: OWNER_EMAIL,
      fileId: LEGACY_FILE_ID,
      folderId: "folder-1",
    });

    expect(inspection).toEqual({
      fileId: LEGACY_FILE_ID,
      fileName: LEGACY_FILE_NAME,
      folder: { id: "folder-1", name: "Attendance 2026" },
      month: null,
      sheets: [
        { sheetId: String(sheetIds.get(SHEET_A)), title: SHEET_A },
        { sheetId: String(sheetIds.get(SHEET_B)), title: SHEET_B },
      ],
      hasUntrustedConfig: true,
      members: [],
    });

    expect(fake.events).toEqual(["validate-folder:folder-1"]);
    expect(fake.addedSheetTitles).toEqual([]);
    expect(fake.deletedSheetIds).toEqual([]);
    expect(fake.gridResizes).toEqual([]);
  });

  it("returns the retained member progress of a partial attempt", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);
    fake.failInvite(EMPLOYEE_B);

    const service = legacyService(fake);
    await service.configureExisting(legacyRequest(sheetIds));

    const inspection = await service.inspectExisting({
      ownerEmail: OWNER_EMAIL,
      fileId: LEGACY_FILE_ID,
      folderId: "folder-1",
    });

    expect(inspection.month).toBe("2026-07");
    // The app wrote this configuration itself, so it is resumable, not untrusted.
    expect(inspection.hasUntrustedConfig).toBe(false);
    expect(inspection.members.map((member) => member.setupStatus)).toEqual([
      "ready",
      "invite-failed",
    ]);
  });

  it("refuses a file that is not a direct child of the manager's folder", async () => {
    const fake = createFileDependenciesFake();
    await seedLegacyFile(fake);

    await expect(
      legacyService(fake, legacyDrive(fake, { inFolder: false })).inspectExisting({
        ownerEmail: OWNER_EMAIL,
        fileId: LEGACY_FILE_ID,
        folderId: "folder-1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("SetupService.configureExisting", () => {
  it("configures the existing tabs without creating, resizing, or deleting one", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const result = await legacyService(fake).configureExisting(legacyRequest(sheetIds));

    expect(result).toEqual({
      fileId: LEGACY_FILE_ID,
      fileName: LEGACY_FILE_NAME,
      month: "2026-07",
      folder: { id: "folder-1", name: "Attendance 2026" },
      setupState: "ready",
      complete: true,
      members: [
        {
          displayName: "Employee A",
          email: EMPLOYEE_A,
          sheetId: String(sheetIds.get(SHEET_A)),
          sheetTitle: SHEET_A,
          protectionId: null,
          permissionId: "permission-1",
          setupStatus: "ready",
          error: null,
        },
        {
          displayName: "Employee B",
          email: EMPLOYEE_B,
          sheetId: String(sheetIds.get(SHEET_B)),
          sheetTitle: SHEET_B,
          protectionId: null,
          permissionId: "permission-2",
          setupStatus: "ready",
          error: null,
        },
      ],
    });

    // Only the app's own configuration tab is added; the employee tabs are
    // reused exactly as the manager left them.
    expect(fake.addedSheetTitles).toEqual([CONFIG_SHEET_TITLE]);
    expect(fake.deletedSheetIds).toEqual([]);
    expect(fake.gridResizes).toEqual([]);
    expect(fake.sheetTitles()).toEqual([SHEET_A, SHEET_B, CONFIG_SHEET_TITLE]);
  });

  it("validates the folder before any mutation and invites members one at a time", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    await legacyService(fake).configureExisting(legacyRequest(sheetIds));

    expect(fake.events.at(0)).toBe("validate-folder:folder-1");
    expect(fake.events.slice(-3)).toEqual([
      `invite:${EMPLOYEE_A}`,
      `invite:${EMPLOYEE_B}`,
      "set-app-properties:ready",
    ]);
    expect(fake.appProperties()).toEqual({
      attendanceApp: "v1",
      attendanceSetupState: "ready",
      attendanceMonth: "2026-07",
    });
  });

  it("stores the live sheet titles and leaves the adopted tabs open", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    await legacyService(fake).configureExisting(legacyRequest(sheetIds));
    const { config } = await fake.config.read(LEGACY_FILE_ID);

    expect(config.ownerEmail).toBe(OWNER_EMAIL);
    expect(config.month).toBe("2026-07");
    expect(config.setupState).toBe("ready");
    expect(config.members.map((member) => member.sheetTitle)).toEqual([SHEET_A, SHEET_B]);
    expect(fake.addedProtections.map((protection) => protection.editors)).toEqual([
      [OWNER_EMAIL],
    ]);
  });

  it("replaces an untrusted configuration sheet instead of trusting it", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake, { withUntrustedConfig: true });
    const untrustedSheetId = sheetIds.get(CONFIG_SHEET_TITLE);

    await legacyService(fake).configureExisting(legacyRequest(sheetIds));

    expect(fake.deletedSheetIds).toEqual([untrustedSheetId]);
    expect(fake.addedSheetTitles).toEqual([CONFIG_SHEET_TITLE]);
    expect(fake.sheetTitles()).toEqual([SHEET_A, SHEET_B, CONFIG_SHEET_TITLE]);

    const { config } = await fake.config.read(LEGACY_FILE_ID);
    expect(config.members.map((member) => member.email)).toEqual([EMPLOYEE_A, EMPLOYEE_B]);
  });

  it("rejects duplicate member emails before any Google call", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const error = await legacyService(fake)
      .configureExisting(
        legacyRequest(sheetIds, {
          mappings: [
            { sheetId: String(sheetIds.get(SHEET_A)), displayName: "A", email: EMPLOYEE_A },
            { sheetId: String(sheetIds.get(SHEET_B)), displayName: "A again", email: "Employee-A@Blended-Asia.com" },
          ],
        }),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "duplicate-member-email" });
    expect(fake.events).toEqual([]);
    expect(fake.addedSheetTitles).toEqual([]);
  });

  it("rejects two mappings for the same sheet before any Google call", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const error = await legacyService(fake)
      .configureExisting(
        legacyRequest(sheetIds, {
          mappings: [
            { sheetId: String(sheetIds.get(SHEET_A)), displayName: "A", email: EMPLOYEE_A },
            { sheetId: String(sheetIds.get(SHEET_A)), displayName: "B", email: EMPLOYEE_B },
          ],
        }),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "duplicate-sheet-mapping" });
    expect(fake.events).toEqual([]);
  });

  it("requires one mapping for every employee sheet in the file", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const error = await legacyService(fake)
      .configureExisting(
        legacyRequest(sheetIds, {
          mappings: [
            { sheetId: String(sheetIds.get(SHEET_A)), displayName: "A", email: EMPLOYEE_A },
          ],
        }),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "unmapped-employee-sheet" });
    expect(fake.addedSheetTitles).toEqual([]);
  });

  it("refuses a mapping to a sheet the file does not have", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const error = await legacyService(fake)
      .configureExisting(
        legacyRequest(sheetIds, {
          mappings: [
            { sheetId: "9999", displayName: "A", email: EMPLOYEE_A },
            { sheetId: String(sheetIds.get(SHEET_B)), displayName: "B", email: EMPLOYEE_B },
          ],
        }),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "member-sheet-missing" });
    expect(fake.addedSheetTitles).toEqual([]);
  });

  it("refuses a file the signed-in manager does not currently own", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    await expect(
      legacyService(fake, legacyDrive(fake, { ownerEmail: "someone-else@blended-asia.com" }))
        .configureExisting(legacyRequest(sheetIds)),
    ).rejects.toBeInstanceOf(AccessError);

    expect(fake.events).toEqual([]);
  });

  it("refuses a file whose current Drive name is not an attendance file", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const error = await legacyService(fake, legacyDrive(fake, { name: "Renamed workbook" }))
      .configureExisting(legacyRequest(sheetIds))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "file-not-supported" });
    expect(fake.addedSheetTitles).toEqual([]);
  });

  it("retains the tabs, mappings, and protections when an invitation fails", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);
    fake.failInvite(EMPLOYEE_B, new Error("Drive rejected sharing for quota-user-42."));

    const result = await legacyService(fake).configureExisting(legacyRequest(sheetIds));

    expect(result.complete).toBe(false);
    expect(result.setupState).toBe("pending");
    expect(result.members[1]).toMatchObject({
      email: EMPLOYEE_B,
      sheetId: String(sheetIds.get(SHEET_B)),
      permissionId: null,
      setupStatus: "invite-failed",
      error: MEMBER_INVITE_FAILED_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("quota-user-42");
    expect(fake.appProperties().attendanceSetupState).toBe("pending");
  });

  it("resumes partial member setup without rewriting the configuration or the tabs", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);
    fake.failInvite(EMPLOYEE_B);

    const service = legacyService(fake);
    await service.configureExisting(legacyRequest(sheetIds));

    const addedTitles = [...fake.addedSheetTitles];
    const protections = [...fake.addedProtections];

    fake.clearInviteFailures();
    fake.clearEvents();

    const resumed = await service.configureExisting(legacyRequest(sheetIds));

    expect(fake.events).toEqual([
      "validate-folder:folder-1",
      `invite:${EMPLOYEE_B}`,
      "set-app-properties:ready",
    ]);
    expect(fake.addedSheetTitles).toEqual(addedTitles);
    expect(fake.addedProtections).toEqual(protections);
    expect(fake.deletedSheetIds).toEqual([]);
    // Replaying the template would shrink a populated tab back to the month grid.
    expect(fake.gridResizes).toEqual([]);
    expect(fake.invitedEmails).toEqual([EMPLOYEE_A, EMPLOYEE_B, EMPLOYEE_B]);

    expect(resumed.complete).toBe(true);
    expect(resumed.setupState).toBe("ready");
    expect(resumed.members.map((member) => member.setupStatus)).toEqual(["ready", "ready"]);
  });

  it("refuses to re-point a configured member at a different sheet", async () => {
    const fake = createFileDependenciesFake();
    const sheetIds = await seedLegacyFile(fake);

    const service = legacyService(fake);
    await service.configureExisting(legacyRequest(sheetIds));

    const error = await service
      .configureExisting(
        legacyRequest(sheetIds, {
          mappings: [
            { sheetId: String(sheetIds.get(SHEET_B)), displayName: "Employee A", email: EMPLOYEE_A },
            { sheetId: String(sheetIds.get(SHEET_A)), displayName: "Employee B", email: EMPLOYEE_B },
          ],
        }),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LegacySetupError);
    expect(error).toMatchObject({ code: "mapping-conflict" });
  });
});
