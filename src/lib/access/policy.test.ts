import { describe, expect, it } from "vitest";
import {
  AccessError,
  ForbiddenError,
  authorizeFile,
  isAccessError,
  type AccessDependencies,
} from "./policy";
import { FileUnavailableError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  CreatedDriveFile,
  DriveFileAccess,
  DriveFolder,
  DriveGateway,
} from "@/lib/google/types";

/* -------------------------------------------------------------------------- */
/* Fixtures and local fakes                                                    */
/* -------------------------------------------------------------------------- */

const MANAGER = "manager@blended-asia.com";
const EMPLOYEE = "employee-a@blended-asia.com";

function driveAccess(overrides: Partial<DriveFileAccess> = {}): DriveFileAccess {
  return {
    id: "file-1",
    name: "202607勤怠管理表",
    mimeType: "application/vnd.google-apps.spreadsheet",
    trashed: false,
    ownedByMe: true,
    ownerEmail: MANAGER,
    appProperties: { attendanceApp: "v1" },
    canEdit: true,
    ...overrides,
  };
}

interface FakeDrive extends DriveGateway {
  accessCalls: string[];
}

function createFakeDrive(access: DriveFileAccess): FakeDrive {
  const accessCalls: string[] = [];
  const unused = (name: string) => (): never => {
    throw new Error(`unexpected call to ${name}`);
  };

  return {
    accessCalls,
    async getFileAccess(fileId) {
      accessCalls.push(fileId);
      return access;
    },
    validateManagerFolder: unused("validateManagerFolder") as unknown as (
      folderId: string,
    ) => Promise<DriveFolder>,
    listManagerFiles: unused("listManagerFiles") as unknown as (
      folderId: string,
    ) => Promise<AttendanceFileSummary[]>,
    listEmployeeCandidates: unused("listEmployeeCandidates") as unknown as () => Promise<
      AttendanceFileSummary[]
    >,
    createSpreadsheetFile: unused("createSpreadsheetFile") as unknown as () => Promise<CreatedDriveFile>,
    convertXlsx: unused("convertXlsx") as unknown as () => Promise<CreatedDriveFile>,
    createWriterPermission: unused("createWriterPermission") as unknown as () => Promise<string>,
    listPeople: unused("listPeople") as unknown as () => Promise<never[]>,
    updateAppProperties: unused("updateAppProperties") as unknown as () => Promise<void>,
  };
}

function dependencies(access: DriveFileAccess): AccessDependencies & { drive: FakeDrive } {
  return { drive: createFakeDrive(access) };
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

describe("authorizeFile — the current Drive owner", () => {
  it("is the manager, decided from live Drive metadata", async () => {
    const deps = dependencies(driveAccess());

    const role = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: "Manager@Blended-Asia.com",
    });

    expect(role).toEqual({ kind: "manager", email: MANAGER });
    // Re-read every call: never a cached role.
    expect(deps.drive.accessCalls).toEqual(["file-1"]);
  });

  it("is not the manager when Drive does not say the file is theirs", async () => {
    // A Shared Drive file: organization-owned, so nobody is the current owner.
    const role = await authorizeFile(dependencies(driveAccess({ ownedByMe: false })), {
      fileId: "file-1",
      actorEmail: MANAGER,
    });

    expect(role.kind).toBe("open");
  });

  it("is not the manager when `ownedByMe` is true but the owner email differs", async () => {
    const role = await authorizeFile(
      dependencies(driveAccess({ ownerEmail: "someone.else@blended-asia.com" })),
      { fileId: "file-1", actorEmail: MANAGER },
    );

    expect(role.kind).toBe("open");
  });
});

/* -------------------------------------------------------------------------- */
/* Everyone else                                                               */
/* -------------------------------------------------------------------------- */

describe("authorizeFile — everyone who is not the owner", () => {
  const shared = () => driveAccess({ ownedByMe: false, ownerEmail: MANAGER });

  it("gets the tab they asked for, because there is no mapping to restrict against", async () => {
    const role = await authorizeFile(dependencies(shared()), {
      fileId: "file-1",
      actorEmail: EMPLOYEE,
      requestedSheetId: "123",
    });

    expect(role).toEqual({ kind: "open", email: EMPLOYEE, sheetId: "123" });
  });

  it("gets a null sheet when none was asked for", async () => {
    const role = await authorizeFile(dependencies(shared()), {
      fileId: "file-1",
      actorEmail: EMPLOYEE,
    });

    expect(role).toEqual({ kind: "open", email: EMPLOYEE, sheetId: null });
  });

  it("is not refused for a file this app never configured", async () => {
    // The whole point of dropping the `__APP_CONFIG` read: every real file is
    // unconfigured, and the old check refused all of them.
    const role = await authorizeFile(
      dependencies(driveAccess({ ownedByMe: false, appProperties: {} })),
      { fileId: "file-1", actorEmail: EMPLOYEE, requestedSheetId: "999" },
    );

    expect(role).toEqual({ kind: "open", email: EMPLOYEE, sheetId: "999" });
  });

  it("normalizes the actor email before deciding anything", async () => {
    const role = await authorizeFile(dependencies(shared()), {
      fileId: "file-1",
      actorEmail: "  Employee-A@Blended-Asia.COM  ",
    });

    expect(role).toMatchObject({ kind: "open", email: EMPLOYEE });
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

describe("authorizeFile — refusals", () => {
  it("refuses an empty actor email before touching Drive", async () => {
    const deps = dependencies(driveAccess());

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: "   " }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.drive.accessCalls).toEqual([]);
  });

  it("reports a trashed file as unavailable rather than forbidden", async () => {
    await expect(
      authorizeFile(dependencies(driveAccess({ trashed: true })), {
        fileId: "file-1",
        actorEmail: MANAGER,
      }),
    ).rejects.toBeInstanceOf(FileUnavailableError);
  });

  it("names no other member in a refusal", async () => {
    try {
      await authorizeFile(dependencies(driveAccess()), { fileId: "file-1", actorEmail: "" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isAccessError(error)).toBe(true);
      const access = error as AccessError;
      expect(access.message).toBe("You do not have access to this attendance sheet.");
      expect(JSON.stringify({ ...access, message: access.message })).not.toContain("@");
    }
  });
});
