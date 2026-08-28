import { describe, expect, it } from "vitest";
import { createFileDependenciesFake } from "../../../tests/fakes/file-dependencies";
import { CONFIG_SHEET_TITLE } from "@/lib/config/schema";
import type { DriveGateway } from "@/lib/google/types";
import { createFileInputSchema } from "./schemas";
import {
  MEMBER_INVITE_FAILED_MESSAGE,
  SetupError,
  createSetupService,
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
          protectionId: "2",
          permissionId: "permission-1",
          setupStatus: "complete",
          error: null,
        },
        {
          displayName: "Employee B",
          email: EMPLOYEE_B,
          sheetId: "2",
          sheetTitle: "Employee B",
          protectionId: "3",
          permissionId: "permission-2",
          setupStatus: "complete",
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
    expect(config.members.every((member) => member.setupStatus === "complete")).toBe(true);
    expect(config.statuses.map((status) => status.sheetValue)).toEqual(["出社", "欠勤"]);
  });

  it("protects every employee tab for the owner and only that member", async () => {
    const fake = createFileDependenciesFake();

    await serviceFor(fake).create({ ownerEmail: OWNER_EMAIL, request: validRequest });

    expect(fake.addedProtections).toEqual([
      { sheetId: 3, editors: [OWNER_EMAIL] },
      { sheetId: 1, editors: [OWNER_EMAIL, EMPLOYEE_A] },
      { sheetId: 2, editors: [OWNER_EMAIL, EMPLOYEE_B] },
    ]);
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
          return await fake.drive.createWriterPermission(fileId, email);
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
      protectionId: "2",
      permissionId: "permission-1",
      setupStatus: "complete",
      error: null,
    });
    expect(result.members[1]).toMatchObject({
      email: EMPLOYEE_B,
      sheetId: "2",
      protectionId: "3",
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
      "complete",
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
    expect(resumed.members.map((member) => member.setupStatus)).toEqual(["complete", "complete"]);
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
