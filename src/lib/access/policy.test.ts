import { describe, expect, it } from "vitest";
import {
  AccessError,
  ForbiddenError,
  NeedsRepairError,
  NeedsSetupError,
  authorizeFile,
  isAccessError,
  type AccessDependencies,
} from "./policy";
import { AppConfigError, type AppConfig, type ConfigMember } from "@/lib/config/schema";
import { ConfigMissingError, type ConfigReadResult, type ConfigRepository } from "@/lib/config/repository";
import { FileUnavailableError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  CreatedDriveFile,
  DriveFileAccess,
  DriveFolder,
  DriveGateway,
  SheetSummary,
} from "@/lib/google/types";

/* -------------------------------------------------------------------------- */
/* Fixtures and local fakes                                                    */
/* -------------------------------------------------------------------------- */

const MANAGER = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";

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

function member(overrides: Partial<ConfigMember> & { email: string }): ConfigMember {
  return {
    displayName: "Member",
    sheetId: null,
    sheetTitle: null,
    protectionId: null,
    permissionId: null,
    setupStatus: "ready",
    ...overrides,
  };
}

const memberA = member({
  displayName: "Linh",
  email: EMPLOYEE_A,
  sheetId: "123",
  sheetTitle: "Linh",
  protectionId: "456",
  permissionId: "perm-a",
});

const memberB = member({
  displayName: "Mai",
  email: EMPLOYEE_B,
  sheetId: "124",
  sheetTitle: "Mai",
  protectionId: "457",
  permissionId: "perm-b",
});

function appConfig(members: ConfigMember[]): AppConfig {
  return {
    schemaVersion: 1,
    setupState: "ready",
    month: "2026-07",
    ownerEmail: MANAGER,
    templateVersion: 1,
    statuses: [{ code: "office", labelEn: "Office", sheetValue: "出社" }],
    members,
  };
}

function sheetSummary(
  partial: Partial<SheetSummary> & { sheetId: number; title: string },
): SheetSummary {
  return { index: 0, hidden: false, protectedRanges: [], ...partial };
}

const defaultSheets: SheetSummary[] = [
  sheetSummary({ sheetId: 900, title: "__APP_CONFIG", hidden: true }),
  sheetSummary({
    sheetId: 123,
    title: "Linh",
    index: 1,
    protectedRanges: [{ protectedRangeId: 456, sheetId: 123 }],
  }),
  sheetSummary({
    sheetId: 124,
    title: "Mai",
    index: 2,
    protectedRanges: [{ protectedRangeId: 457, sheetId: 124 }],
  }),
];

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

interface FakeConfigRepository extends ConfigRepository {
  readCalls: string[];
}

function createFakeConfig(
  result: ConfigReadResult | (() => never),
): FakeConfigRepository {
  const readCalls: string[] = [];
  const unused = (name: string) => (): never => {
    throw new Error(`unexpected call to ${name}`);
  };

  return {
    readCalls,
    async read(fileId) {
      readCalls.push(fileId);
      if (typeof result === "function") result();
      return result as ConfigReadResult;
    },
    initialize: unused("initialize") as unknown as ConfigRepository["initialize"],
    updateMemberProgress: unused(
      "updateMemberProgress",
    ) as unknown as ConfigRepository["updateMemberProgress"],
    updateSetupState: unused("updateSetupState") as unknown as ConfigRepository["updateSetupState"],
  };
}

function readResult(
  members: ConfigMember[],
  sheets: SheetSummary[] = defaultSheets,
): ConfigReadResult {
  return {
    fileId: "file-1",
    config: appConfig(members),
    configSheetId: 900,
    spreadsheet: { spreadsheetId: "file-1", sheets },
  };
}

function dependencies(
  access: DriveFileAccess,
  config: ConfigRepository,
): AccessDependencies & { drive: FakeDrive } {
  return { drive: createFakeDrive(access), config };
}

/* -------------------------------------------------------------------------- */
/* Manager path                                                                */
/* -------------------------------------------------------------------------- */

describe("authorizeFile manager path", () => {
  it("grants manager access from current Drive ownership without reading config", async () => {
    const config = createFakeConfig(readResult([memberA, memberB]));
    const deps = dependencies(driveAccess(), config);

    const role = await authorizeFile(deps, { fileId: "file-1", actorEmail: "Manager@Blended-Asia.com" });

    expect(role).toEqual({ kind: "manager", email: MANAGER });
    expect(deps.drive.accessCalls).toEqual(["file-1"]);
    expect(config.readCalls).toEqual([]);
  });

  it("still grants manager access when a sheet ID is requested", async () => {
    const config = createFakeConfig(readResult([memberA, memberB]));
    const deps = dependencies(driveAccess(), config);

    const role = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: MANAGER,
      requestedSheetId: "124",
    });

    expect(role.kind).toBe("manager");
  });

  it("grants manager access before any config exists so legacy files can be set up", async () => {
    const config = createFakeConfig(() => {
      throw new ConfigMissingError("file-1");
    });
    const deps = dependencies(driveAccess({ appProperties: {} }), config);

    await expect(authorizeFile(deps, { fileId: "file-1", actorEmail: MANAGER })).resolves.toEqual({
      kind: "manager",
      email: MANAGER,
    });
  });

  it("never grants manager access when the actor does not own the file", async () => {
    const config = createFakeConfig(readResult([memberA]));
    const deps = dependencies(driveAccess({ ownedByMe: false }), config);

    const role = await authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A });

    expect(role.kind).toBe("employee");
  });

  it("never grants manager access when ownedByMe is true but the owner email differs", async () => {
    const config = createFakeConfig(readResult([memberA]));
    const deps = dependencies(driveAccess({ ownedByMe: true, ownerEmail: MANAGER }), config);

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: "impostor@blended-asia.com" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never grants manager access when Drive reports no owner email", async () => {
    const config = createFakeConfig(readResult([memberA]));
    const deps = dependencies(driveAccess({ ownerEmail: null }), config);

    await expect(authorizeFile(deps, { fileId: "file-1", actorEmail: MANAGER })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects a trashed file for everyone", async () => {
    const config = createFakeConfig(readResult([memberA]));
    const deps = dependencies(driveAccess({ trashed: true }), config);

    await expect(authorizeFile(deps, { fileId: "file-1", actorEmail: MANAGER })).rejects.toBeInstanceOf(
      FileUnavailableError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Employee path                                                               */
/* -------------------------------------------------------------------------- */

describe("authorizeFile employee path", () => {
  function employeeDeps(members: ConfigMember[], sheets: SheetSummary[] = defaultSheets) {
    return dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(readResult(members, sheets)),
    );
  }

  it("resolves the mapped sheet with its live title", async () => {
    const deps = employeeDeps([memberA, memberB]);

    const role = await authorizeFile(deps, { fileId: "file-1", actorEmail: "Employee-A@Blended-Asia.com" });

    expect(role).toEqual({
      kind: "employee",
      email: EMPLOYEE_A,
      sheetId: "123",
      sheetTitle: "Linh",
    });
  });

  it("prefers the live sheet title over the recorded title after a rename", async () => {
    const renamed = defaultSheets.map((entry) =>
      entry.sheetId === 123 ? { ...entry, title: "Linh (renamed)" } : entry,
    );
    const deps = employeeDeps([memberA, memberB], renamed);

    const role = await authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A });

    expect(role).toMatchObject({ sheetId: "123", sheetTitle: "Linh (renamed)" });
  });

  it("accepts a requested sheet ID that equals the mapping", async () => {
    const deps = employeeDeps([memberA, memberB]);

    const role = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: EMPLOYEE_A,
      requestedSheetId: "123",
    });

    expect(role.kind).toBe("employee");
  });

  it("throws ForbiddenError when employee A requests employee B's sheet ID", async () => {
    const deps = employeeDeps([memberA, memberB]);

    const error = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: EMPLOYEE_A,
      requestedSheetId: "124",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe("forbidden");
  });

  it("does not disclose the other employee's sheet title, sheet ID, or email", async () => {
    const deps = employeeDeps([memberA, memberB]);

    const error = (await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: EMPLOYEE_A,
      requestedSheetId: "124",
    }).catch((caught: unknown) => caught)) as ForbiddenError;

    const serialized = `${error.message} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain("Mai");
    expect(serialized).not.toContain(EMPLOYEE_B);
    expect(serialized).not.toContain("124");
    expect(serialized).not.toContain("457");
  });

  it("throws ForbiddenError for an actor that is neither owner nor a configured member", async () => {
    const deps = employeeDeps([memberA, memberB]);

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: "outsider@blended-asia.com" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/* -------------------------------------------------------------------------- */
/* Needs setup / needs repair                                                  */
/* -------------------------------------------------------------------------- */

describe("authorizeFile setup and repair states", () => {
  /**
   * A missing config sheet used to be `NeedsSetupError`. It no longer refuses:
   * the file is opened on Google's own sharing instead. A configuration that
   * exists but is broken is still an error, because that is a real fault
   * rather than an absence.
   */
  it("opens a file with no config sheet instead of demanding setup", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(() => {
        throw new ConfigMissingError("file-1");
      }),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).resolves.toMatchObject({ kind: "open" });
  });

  it("maps an unreadable config to NeedsRepairError", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(() => {
        throw new AppConfigError("invalid-member-row", "members", "Member row 1 is invalid.");
      }),
    );

    const error = await authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NeedsRepairError);
    expect((error as NeedsRepairError).code).toBe("needs-repair");
  });

  it("treats a null sheet mapping as NeedsSetupError instead of a silent match", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(
        readResult([member({ email: EMPLOYEE_A, displayName: "Linh", setupStatus: "pending" })]),
      ),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).rejects.toBeInstanceOf(NeedsSetupError);
  });

  it("never falls back to matching a sheet by title when the mapped sheet ID is absent", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(
        readResult([{ ...memberA, sheetId: "999" }]),
      ),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).rejects.toBeInstanceOf(NeedsRepairError);
  });

  /*
   * Tabs are created open. A protected range is not evidence of anything this
   * app decides, and every real workbook was measured with none at all, so
   * demanding one only ever refused the people using the app while the same
   * edit stayed available in Google Sheets itself.
   */
  it("opens a mapped sheet that records no protection", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(readResult([{ ...memberA, protectionId: null }])),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).resolves.toMatchObject({ kind: "employee", email: EMPLOYEE_A, sheetId: "123" });
  });

  it("opens a mapped sheet that carries no protected range at all", async () => {
    const unprotected = defaultSheets.map((entry) =>
      entry.sheetId === 123 ? { ...entry, protectedRanges: [] } : entry,
    );
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(readResult([memberA], unprotected)),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).resolves.toMatchObject({ kind: "employee", email: EMPLOYEE_A, sheetId: "123" });
  });

  it("exposes a shared access-error base and type guard", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false }),
      createFakeConfig(readResult([memberA, memberB])),
    );

    const error = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: EMPLOYEE_A,
      requestedSheetId: "124",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AccessError);
    expect(isAccessError(error)).toBe(true);
    expect(isAccessError(new Error("other"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Files with no app configuration                                             */
/* -------------------------------------------------------------------------- */

describe("authorizeFile — files this app never configured", () => {
  const noConfig = () =>
    createFakeConfig(() => {
      throw new ConfigMissingError("file-1");
    });

  it("lets a non-owner open a tab of a file Drive already let them read", async () => {
    // A shared-drive month: nobody owns it, and it carries no configuration.
    const deps = dependencies(
      driveAccess({ ownedByMe: false, ownerEmail: null, appProperties: {} }),
      noConfig(),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A, requestedSheetId: "77" }),
    ).resolves.toEqual({ kind: "open", email: EMPLOYEE_A, sheetId: "77" });
  });

  it("does not restrict which tab an unconfigured file may open", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false, ownerEmail: null, appProperties: {} }),
      noConfig(),
    );

    const role = await authorizeFile(deps, {
      fileId: "file-1",
      actorEmail: EMPLOYEE_B,
      requestedSheetId: "999",
    });

    expect(role).toMatchObject({ kind: "open", sheetId: "999" });
  });

  it("still refuses a trashed file", async () => {
    const deps = dependencies(
      driveAccess({ ownedByMe: false, ownerEmail: null, trashed: true }),
      noConfig(),
    );

    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).rejects.toThrow();
  });

  it("still refuses an actor with no verified email", async () => {
    const deps = dependencies(driveAccess({ ownedByMe: false }), noConfig());

    await expect(authorizeFile(deps, { fileId: "file-1", actorEmail: "   " })).rejects.toThrow();
  });

  it("keeps the mapped-employee restriction wherever a configuration does exist", async () => {
    const config = createFakeConfig(readResult([memberA]));
    const deps = dependencies(driveAccess({ ownedByMe: false }), config);

    // memberA maps to sheet 123 only; another tab is still refused.
    await expect(
      authorizeFile(deps, { fileId: "file-1", actorEmail: EMPLOYEE_A, requestedSheetId: "999" }),
    ).rejects.toThrow();
  });
});
