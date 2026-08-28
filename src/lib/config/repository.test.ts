import { describe, expect, it } from "vitest";
import {
  APP_PROPERTY_APP,
  APP_PROPERTY_APP_VERSION,
  APP_PROPERTY_MONTH,
  APP_PROPERTY_SETUP_STATE,
  CONFIG_SETUP_STATE_CELL,
  ConfigMissingError,
  ConfigSheetExistsError,
  configMemberRowRange,
  createConfigRepository,
  isConfigRepositoryError,
} from "./repository";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  isAppConfigError,
  type ConfigMember,
  type ConfigStatus,
} from "./schema";
import type {
  AttendanceFileSummary,
  BatchUpdateResult,
  CreatedDriveFile,
  DriveFileAccess,
  DriveFolder,
  DriveGateway,
  RangeValues,
  SheetBatchReply,
  SheetRequest,
  SheetSummary,
  SheetsGateway,
  SpreadsheetSnapshot,
  ValuePatch,
} from "@/lib/google/types";

/* -------------------------------------------------------------------------- */
/* Local fakes (kept in this file so the shared fixtures stay untouched)       */
/* -------------------------------------------------------------------------- */

interface FakeSheetsOptions {
  sheets?: SheetSummary[];
  values?: Record<string, string[][]>;
  replies?: SheetBatchReply[][];
}

interface FakeSheets extends SheetsGateway {
  events: string[];
  batchUpdates: SheetRequest[][];
  patches: ValuePatch[][];
  requestedRanges: string[][];
}

function sheet(partial: Partial<SheetSummary> & { sheetId: number; title: string }): SheetSummary {
  return {
    index: 0,
    hidden: false,
    protectedRanges: [],
    ...partial,
  };
}

function createFakeSheets(options: FakeSheetsOptions = {}): FakeSheets {
  const events: string[] = [];
  const batchUpdates: SheetRequest[][] = [];
  const patches: ValuePatch[][] = [];
  const requestedRanges: string[][] = [];
  const values = options.values ?? {};
  const replies = options.replies ?? [];

  return {
    events,
    batchUpdates,
    patches,
    requestedRanges,
    async getSpreadsheet(fileId): Promise<SpreadsheetSnapshot> {
      events.push("getSpreadsheet");
      return { spreadsheetId: fileId, sheets: options.sheets ?? [] };
    },
    async batchUpdate(fileId, requests): Promise<BatchUpdateResult> {
      events.push(`batchUpdate:${requests.map((request) => Object.keys(request)[0]).join(",")}`);
      batchUpdates.push(requests);
      return { spreadsheetId: fileId, replies: replies[batchUpdates.length - 1] ?? [] };
    },
    async getValues(_fileId, ranges): Promise<RangeValues[]> {
      events.push("getValues");
      requestedRanges.push([...ranges]);
      return ranges.map((range) => ({ range, values: values[range] ?? [] }));
    },
    async updateValues(_fileId, nextPatches): Promise<void> {
      events.push(`updateValues:${nextPatches.map((patch) => patch.range).join(",")}`);
      patches.push([...nextPatches]);
    },
  };
}

interface FakeDrive extends DriveGateway {
  events: string[];
  appPropertyWrites: Record<string, string>[];
}

function createFakeDrive(): FakeDrive {
  const events: string[] = [];
  const appPropertyWrites: Record<string, string>[] = [];

  const unused = (name: string) => (): never => {
    throw new Error(`unexpected call to ${name}`);
  };

  return {
    events,
    appPropertyWrites,
    validateManagerFolder: unused("validateManagerFolder") as unknown as (
      folderId: string,
    ) => Promise<DriveFolder>,
    listManagerFiles: unused("listManagerFiles") as unknown as (
      folderId: string,
    ) => Promise<AttendanceFileSummary[]>,
    listEmployeeCandidates: unused("listEmployeeCandidates") as unknown as () => Promise<
      AttendanceFileSummary[]
    >,
    getFileAccess: unused("getFileAccess") as unknown as (fileId: string) => Promise<DriveFileAccess>,
    createSpreadsheetFile: unused("createSpreadsheetFile") as unknown as () => Promise<CreatedDriveFile>,
    convertXlsx: unused("convertXlsx") as unknown as () => Promise<CreatedDriveFile>,
    createWriterPermission: unused("createWriterPermission") as unknown as () => Promise<string>,
    async updateAppProperties(_fileId, properties): Promise<void> {
      events.push(`updateAppProperties:${Object.keys(properties).join(",")}`);
      appPropertyWrites.push({ ...properties });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const CONFIG_SHEET_ID = 900;

const settingsRows = [
  ["schemaVersion", "1"],
  ["setupState", "ready"],
  ["month", "2026-07"],
  ["ownerEmail", "manager@blended-asia.com"],
  ["templateVersion", "1"],
];

const statusRows = [
  ["code", "labelEn", "sheetValue"],
  ["office", "Office", "出社"],
];

const memberRows = [
  ["displayName", "email", "sheetId", "sheetTitle", "protectionId", "permissionId", "setupStatus"],
  ["Linh", "employee-a@blended-asia.com", "123", "Linh", "456", "perm-1", "ready"],
  ["Mai", "employee-b@blended-asia.com", "124", "Mai", "457", "perm-2", "ready"],
];

function configValues(overrides: Record<string, string[][]> = {}): Record<string, string[][]> {
  return {
    [CONFIG_SETTINGS_RANGE]: settingsRows,
    [CONFIG_STATUS_RANGE]: statusRows,
    [CONFIG_MEMBER_RANGE]: memberRows,
    ...overrides,
  };
}

const configuredSheets: SheetSummary[] = [
  sheet({ sheetId: CONFIG_SHEET_ID, title: CONFIG_SHEET_TITLE, hidden: true, index: 0 }),
  sheet({ sheetId: 123, title: "Linh", index: 1 }),
];

const statuses: ConfigStatus[] = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
];

const pendingMember: ConfigMember = {
  displayName: "Linh",
  email: "employee-a@blended-asia.com",
  sheetId: null,
  sheetTitle: null,
  protectionId: null,
  permissionId: null,
  setupStatus: "pending",
};

/* -------------------------------------------------------------------------- */
/* read                                                                        */
/* -------------------------------------------------------------------------- */

describe("ConfigRepository.read", () => {
  it("reads the three fixed config ranges and returns the parsed config with the snapshot", async () => {
    const sheets = createFakeSheets({ sheets: configuredSheets, values: configValues() });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    const result = await repository.read("file-1");

    expect(sheets.requestedRanges).toEqual([
      [CONFIG_SETTINGS_RANGE, CONFIG_STATUS_RANGE, CONFIG_MEMBER_RANGE],
    ]);
    expect(sheets.events).toEqual(["getSpreadsheet", "getValues"]);
    expect(result.fileId).toBe("file-1");
    expect(result.configSheetId).toBe(CONFIG_SHEET_ID);
    expect(result.spreadsheet.sheets.map((entry) => entry.sheetId)).toEqual([CONFIG_SHEET_ID, 123]);
    expect(result.config.ownerEmail).toBe("manager@blended-asia.com");
    expect(result.config.month).toBe("2026-07");
    expect(result.config.members.map((member) => member.email)).toEqual([
      "employee-a@blended-asia.com",
      "employee-b@blended-asia.com",
    ]);
    expect(result.config.members[0].sheetId).toBe("123");
  });

  it("stops member and status parsing at the first fully blank row", async () => {
    const sheets = createFakeSheets({
      sheets: configuredSheets,
      values: configValues({
        [CONFIG_STATUS_RANGE]: [...statusRows, ["", "", ""], ["ghost", "Ghost", "幽霊"]],
        [CONFIG_MEMBER_RANGE]: [
          ...memberRows,
          ["", "", "", "", "", "", ""],
          ["Ghost", "ghost@blended-asia.com", "", "", "", "", "pending"],
        ],
      }),
    });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    const { config } = await repository.read("file-1");

    expect(config.statuses).toHaveLength(1);
    expect(config.members).toHaveLength(2);
  });

  it("throws ConfigMissingError and reads no values when the config sheet is absent", async () => {
    const sheets = createFakeSheets({ sheets: [sheet({ sheetId: 123, title: "Linh" })] });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    await expect(repository.read("file-1")).rejects.toBeInstanceOf(ConfigMissingError);
    expect(sheets.events).toEqual(["getSpreadsheet"]);
  });

  it("exposes a type guard for repository errors", async () => {
    const sheets = createFakeSheets({ sheets: [] });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    const error = await repository.read("file-1").catch((caught: unknown) => caught);

    expect(isConfigRepositoryError(error)).toBe(true);
    expect(isConfigRepositoryError(new Error("other"))).toBe(false);
  });

  it("propagates schema errors from malformed config rows", async () => {
    const sheets = createFakeSheets({
      sheets: configuredSheets,
      values: configValues({
        [CONFIG_SETTINGS_RANGE]: [
          ["schemaVersion", "2"],
          ["setupState", "ready"],
          ["month", "2026-07"],
          ["ownerEmail", "manager@blended-asia.com"],
          ["templateVersion", "1"],
        ],
      }),
    });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    const error = await repository.read("file-1").catch((caught: unknown) => caught);

    expect(isAppConfigError(error)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* initialize                                                                  */
/* -------------------------------------------------------------------------- */

describe("ConfigRepository.initialize", () => {
  function initializeFixture() {
    const sheets = createFakeSheets({
      sheets: [sheet({ sheetId: 0, title: "Sheet1" })],
      replies: [
        [{ addSheet: { sheetId: CONFIG_SHEET_ID, title: CONFIG_SHEET_TITLE } }],
        [{ addProtectedRange: { protectedRangeId: 77 } }],
      ],
    });
    const drive = createFakeDrive();
    return { sheets, drive, repository: createConfigRepository({ sheets, drive }) };
  }

  it("creates the hidden sheet, writes version-1 tables, protects it owner-only, then sets app properties", async () => {
    const { sheets, drive, repository } = initializeFixture();

    const result = await repository.initialize({
      fileId: "file-1",
      month: "2026-07",
      ownerEmail: "Manager@Blended-Asia.com",
      statuses,
      members: [pendingMember],
    });

    expect(sheets.events).toEqual([
      "getSpreadsheet",
      "batchUpdate:addSheet",
      `updateValues:${CONFIG_SETTINGS_RANGE},${CONFIG_STATUS_RANGE},${CONFIG_MEMBER_RANGE}`,
      "batchUpdate:addProtectedRange",
    ]);
    expect(drive.events).toEqual(["updateAppProperties:attendanceApp,attendanceSetupState,attendanceMonth"]);

    const addSheet = sheets.batchUpdates[0][0] as {
      addSheet: { properties: { title: string; hidden: boolean } };
    };
    expect(addSheet.addSheet.properties.title).toBe(CONFIG_SHEET_TITLE);
    expect(addSheet.addSheet.properties.hidden).toBe(true);

    const addProtectedRange = sheets.batchUpdates[1][0] as {
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: number };
          warningOnly: boolean;
          requestingUserCanEdit: boolean;
          editors: { users: string[]; domainUsersCanEdit: boolean };
        };
      };
    };
    expect(addProtectedRange.addProtectedRange.protectedRange.range).toEqual({ sheetId: CONFIG_SHEET_ID });
    expect(addProtectedRange.addProtectedRange.protectedRange.warningOnly).toBe(false);
    expect(addProtectedRange.addProtectedRange.protectedRange.editors.users).toEqual([
      "manager@blended-asia.com",
    ]);
    expect(addProtectedRange.addProtectedRange.protectedRange.editors.domainUsersCanEdit).toBe(false);

    expect(result.sheetId).toBe("900");
    expect(result.protectionId).toBe("77");
    expect(result.config.setupState).toBe("pending");
    expect(result.config.ownerEmail).toBe("manager@blended-asia.com");
    expect(result.config.templateVersion).toBe(1);
  });

  it("writes the exact Drive app properties contract", async () => {
    const { drive, repository } = initializeFixture();

    await repository.initialize({
      fileId: "file-1",
      month: "2026-07",
      ownerEmail: "manager@blended-asia.com",
      statuses,
      members: [],
    });

    expect(drive.appPropertyWrites).toEqual([
      {
        [APP_PROPERTY_APP]: APP_PROPERTY_APP_VERSION,
        [APP_PROPERTY_SETUP_STATE]: "pending",
        [APP_PROPERTY_MONTH]: "2026-07",
      },
    ]);
    expect(APP_PROPERTY_APP_VERSION).toBe("v1");
  });

  it("writes settings, statuses, and members as version-1 tables with string resource IDs", async () => {
    const { sheets, repository } = initializeFixture();

    await repository.initialize({
      fileId: "file-1",
      month: "2026-07",
      ownerEmail: "manager@blended-asia.com",
      statuses,
      members: [{ ...pendingMember, sheetId: "123", protectionId: "456", setupStatus: "ready" }],
    });

    const [settings, statusTable, members] = sheets.patches[0];
    expect(settings.values).toEqual([
      ["schemaVersion", "1"],
      ["setupState", "pending"],
      ["month", "2026-07"],
      ["ownerEmail", "manager@blended-asia.com"],
      ["templateVersion", "1"],
    ]);
    expect(statusTable.values[0]).toEqual(["code", "labelEn", "sheetValue"]);
    expect(members.values[1]).toEqual([
      "Linh",
      "employee-a@blended-asia.com",
      "123",
      "",
      "456",
      "",
      "ready",
    ]);
  });

  it("rejects invalid input before any Google mutation", async () => {
    const { sheets, drive, repository } = initializeFixture();

    await expect(
      repository.initialize({
        fileId: "file-1",
        month: "2026-13",
        ownerEmail: "manager@blended-asia.com",
        statuses,
        members: [],
      }),
    ).rejects.toSatisfy(isAppConfigError);

    expect(sheets.batchUpdates).toEqual([]);
    expect(drive.appPropertyWrites).toEqual([]);
  });

  it("refuses to overwrite an existing config sheet unless replacement is explicit", async () => {
    const sheets = createFakeSheets({ sheets: configuredSheets });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    await expect(
      repository.initialize({
        fileId: "file-1",
        month: "2026-07",
        ownerEmail: "manager@blended-asia.com",
        statuses,
        members: [],
      }),
    ).rejects.toBeInstanceOf(ConfigSheetExistsError);
    expect(sheets.batchUpdates).toEqual([]);
  });

  it("deletes and recreates the config sheet when replacement is requested explicitly", async () => {
    const sheets = createFakeSheets({
      sheets: configuredSheets,
      replies: [
        [{}, { addSheet: { sheetId: 901, title: CONFIG_SHEET_TITLE } }],
        [{ addProtectedRange: { protectedRangeId: 78 } }],
      ],
    });
    const repository = createConfigRepository({ sheets, drive: createFakeDrive() });

    const result = await repository.initialize({
      fileId: "file-1",
      month: "2026-07",
      ownerEmail: "manager@blended-asia.com",
      statuses,
      members: [],
      replaceExisting: true,
    });

    expect(sheets.batchUpdates[0]).toEqual([
      { deleteSheet: { sheetId: CONFIG_SHEET_ID } },
      { addSheet: { properties: { title: CONFIG_SHEET_TITLE, hidden: true } } },
    ]);
    expect(result.sheetId).toBe("901");
  });
});

/* -------------------------------------------------------------------------- */
/* updateMemberProgress                                                        */
/* -------------------------------------------------------------------------- */

describe("ConfigRepository.updateMemberProgress", () => {
  function progressFixture(values = configValues()) {
    const sheets = createFakeSheets({ sheets: configuredSheets, values });
    const drive = createFakeDrive();
    return { sheets, drive, repository: createConfigRepository({ sheets, drive }) };
  }

  it("patches only the affected member row and never another config range", async () => {
    const { sheets, drive, repository } = progressFixture();

    const member = await repository.updateMemberProgress("file-1", {
      email: "Employee-B@Blended-Asia.com",
      permissionId: "perm-new",
      setupStatus: "invite-failed",
    });

    expect(sheets.patches).toHaveLength(1);
    expect(sheets.patches[0]).toHaveLength(1);
    expect(sheets.patches[0][0].range).toBe(configMemberRowRange(1));
    expect(sheets.patches[0][0].range).toBe(`${CONFIG_SHEET_TITLE}!H3:N3`);
    expect(sheets.patches[0][0].values).toEqual([
      ["Mai", "employee-b@blended-asia.com", "124", "Mai", "457", "perm-new", "invite-failed"],
    ]);
    expect(member.setupStatus).toBe("invite-failed");
    expect(drive.appPropertyWrites).toEqual([]);
  });

  it("converts numeric Google IDs to strings before writing", async () => {
    const { sheets, repository } = progressFixture(
      configValues({
        [CONFIG_MEMBER_RANGE]: [
          memberRows[0],
          ["Linh", "employee-a@blended-asia.com", "", "", "", "", "pending"],
        ],
      }),
    );

    const member = await repository.updateMemberProgress("file-1", {
      email: "employee-a@blended-asia.com",
      sheetId: 123,
      sheetTitle: "Linh",
      protectionId: 456,
      setupStatus: "ready",
    });

    expect(member.sheetId).toBe("123");
    expect(member.protectionId).toBe("456");
    expect(sheets.patches[0][0].values).toEqual([
      ["Linh", "employee-a@blended-asia.com", "123", "Linh", "456", "", "ready"],
    ]);
  });

  it("appends a new member row when the email is not yet recorded", async () => {
    const { sheets, repository } = progressFixture();

    const member = await repository.updateMemberProgress("file-1", {
      email: "New.Person@Blended-Asia.com",
      displayName: "New Person",
      setupStatus: "pending",
    });

    expect(member.email).toBe("new.person@blended-asia.com");
    expect(sheets.patches[0][0].range).toBe(configMemberRowRange(2));
    expect(sheets.patches[0][0].values).toEqual([
      ["New Person", "new.person@blended-asia.com", "", "", "", "", "pending"],
    ]);
  });

  it("rejects a duplicate sheet ID without writing anything", async () => {
    const { sheets, repository } = progressFixture();

    await expect(
      repository.updateMemberProgress("file-1", {
        email: "employee-b@blended-asia.com",
        sheetId: 123,
      }),
    ).rejects.toSatisfy(isAppConfigError);

    expect(sheets.patches).toEqual([]);
  });

  it("rejects a new member row that has no display name", async () => {
    const { sheets, repository } = progressFixture();

    await expect(
      repository.updateMemberProgress("file-1", {
        email: "nameless@blended-asia.com",
        setupStatus: "pending",
      }),
    ).rejects.toSatisfy(isAppConfigError);

    expect(sheets.patches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* updateSetupState                                                            */
/* -------------------------------------------------------------------------- */

describe("ConfigRepository.updateSetupState", () => {
  it("patches only the setup-state cell and only the setup-state app property", async () => {
    const sheets = createFakeSheets({ sheets: configuredSheets, values: configValues() });
    const drive = createFakeDrive();
    const repository = createConfigRepository({ sheets, drive });

    await repository.updateSetupState("file-1", "needs-repair");

    expect(sheets.patches).toEqual([
      [{ range: CONFIG_SETUP_STATE_CELL, values: [["needs-repair"]] }],
    ]);
    expect(CONFIG_SETUP_STATE_CELL).toBe(`${CONFIG_SHEET_TITLE}!B2`);
    expect(sheets.events).toEqual([`updateValues:${CONFIG_SETUP_STATE_CELL}`]);
    expect(drive.appPropertyWrites).toEqual([{ [APP_PROPERTY_SETUP_STATE]: "needs-repair" }]);
  });
});
