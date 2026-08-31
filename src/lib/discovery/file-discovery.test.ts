import { describe, expect, it, vi } from "vitest";
import { ConfigMissingError, type ConfigReadResult, type ConfigRepository } from "@/lib/config/repository";
import { AppConfigError, type AppConfig } from "@/lib/config/schema";
import { FolderUnavailableError, GoogleApiError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  DriveGateway,
  SheetsGateway,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import { createFileDiscovery } from "./file-discovery";

/* -------------------------------------------------------------------------- */
/* Actors                                                                      */
/* -------------------------------------------------------------------------- */

const MANAGER = "manager@blended-asia.com";
const EMPLOYEE = "employee@blended-asia.com";
const FOLDER_ID = "folder-1";

const MARKER_NAME = "202607勤怠管理表";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface CorpusFile extends AttendanceFileSummary {
  /** Simulates the Drive `'<folderId>' in parents` query; direct children only. */
  parents: string[];
}

function corpusFile(overrides: Partial<CorpusFile> & { id: string }): CorpusFile {
  return {
    name: MARKER_NAME,
    ownedByMe: false,
    sharedWithMe: false,
    ownerEmail: null,
    appProperties: {},
    modifiedTime: null,
    parents: [],
    ...overrides,
  };
}

function toSummary({ parents: _parents, ...summary }: CorpusFile): AttendanceFileSummary {
  return summary;
}

/** Files Drive would return for `'folder-1' in parents`, plus decoys. */
const driveCorpus: CorpusFile[] = [
  corpusFile({
    id: "direct-ready",
    name: MARKER_NAME,
    parents: [FOLDER_ID],
    ownedByMe: true,
    ownerEmail: MANAGER,
    modifiedTime: "2026-07-30T09:00:00.000Z",
    appProperties: { attendanceApp: "v1", attendanceSetupState: "ready", attendanceMonth: "2026-07" },
  }),
  corpusFile({
    id: "direct-legacy",
    name: "202605勤怠管理表",
    parents: [FOLDER_ID],
    ownedByMe: true,
    ownerEmail: MANAGER,
    modifiedTime: "2026-05-30T09:00:00.000Z",
  }),
  corpusFile({
    id: "wrong-name",
    name: "202607 Attendance",
    parents: [FOLDER_ID],
    ownedByMe: true,
    ownerEmail: MANAGER,
  }),
  corpusFile({
    id: "not-owned",
    parents: [FOLDER_ID],
    ownedByMe: false,
    ownerEmail: "someone-else@blended-asia.com",
  }),
  corpusFile({
    id: "nested-file",
    parents: ["folder-1-child"],
    ownedByMe: true,
    ownerEmail: MANAGER,
  }),
];

/** Files Drive would return for the `sharedWithMe = true` spreadsheet query. */
const sharedCorpus: CorpusFile[] = [
  corpusFile({
    id: "shared-mapped",
    name: MARKER_NAME,
    sharedWithMe: true,
    // Mixed case on purpose: the owner-domain test is case-insensitive.
    ownerEmail: "Owner@Blended-Asia.COM",
    modifiedTime: "2026-07-29T01:02:03.000Z",
    appProperties: { attendanceMonth: "2026-07" },
  }),
  corpusFile({ id: "shared-unmapped", sharedWithMe: true, ownerEmail: "owner@blended-asia.com" }),
  corpusFile({ id: "shared-duplicate", sharedWithMe: true, ownerEmail: "owner@blended-asia.com" }),
  corpusFile({ id: "shared-missing-sheet", sharedWithMe: true, ownerEmail: "owner@blended-asia.com" }),
  corpusFile({ id: "shared-unreadable", sharedWithMe: true, ownerEmail: "owner@blended-asia.com" }),
  corpusFile({ id: "shared-external-owner", sharedWithMe: true, ownerEmail: "boss@example.com" }),
  // Case-sensitive substring check: this name stops one character short of the marker.
  corpusFile({
    id: "shared-wrong-name",
    name: "202607勤怠管理",
    sharedWithMe: true,
    ownerEmail: "owner@blended-asia.com",
  }),
  corpusFile({ id: "shared-not-shared", sharedWithMe: false, ownerEmail: "owner@blended-asia.com" }),
];

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    schemaVersion: 1,
    setupState: "ready",
    month: "2026-07",
    ownerEmail: MANAGER,
    templateVersion: 1,
    statuses: [{ code: "work", labelEn: "Work", sheetValue: "出勤" }],
    members: [],
    ...overrides,
  };
}

function member(
  email: string,
  sheetId: string | null,
  displayName = "Member",
): AppConfig["members"][number] {
  return {
    displayName,
    email,
    sheetId,
    sheetTitle: sheetId === null ? null : `Stored ${sheetId}`,
    protectionId: "9",
    permissionId: "p",
    setupStatus: "ready",
  };
}

function snapshot(fileId: string, sheetIds: number[]): SpreadsheetSnapshot {
  return {
    spreadsheetId: fileId,
    sheets: sheetIds.map((sheetId, index) => ({
      sheetId,
      title: `Live ${sheetId}`,
      index,
      hidden: false,
      protectedRanges: [],
    })),
  };
}

function readResult(fileId: string, config: AppConfig, sheetIds: number[]): ConfigReadResult {
  return { fileId, config, configSheetId: 0, spreadsheet: snapshot(fileId, sheetIds) };
}

function defaultConfigs(): Map<string, ConfigReadResult | Error> {
  return new Map<string, ConfigReadResult | Error>([
    [
      "direct-ready",
      readResult(
        "direct-ready",
        appConfig({
          members: [member(EMPLOYEE, "111", "Employee A"), member(MANAGER, "222", "Manager")],
        }),
        [111, 222],
      ),
    ],
    ["direct-legacy", new ConfigMissingError("direct-legacy")],
    [
      "shared-mapped",
      readResult(
        "shared-mapped",
        appConfig({
          ownerEmail: "owner@blended-asia.com",
          members: [member(EMPLOYEE, "111", "Employee A"), member(MANAGER, "222", "Manager")],
        }),
        [111, 222],
      ),
    ],
    [
      "shared-unmapped",
      readResult(
        "shared-unmapped",
        appConfig({ members: [member("other@blended-asia.com", "333")] }),
        [333],
      ),
    ],
    [
      // Two rows resolving to the same actor: never "exactly one" mapping.
      "shared-duplicate",
      readResult(
        "shared-duplicate",
        appConfig({ members: [member(EMPLOYEE, "111"), member(EMPLOYEE, "222")] }),
        [111, 222],
      ),
    ],
    [
      "shared-missing-sheet",
      readResult("shared-missing-sheet", appConfig({ members: [member(EMPLOYEE, "999")] }), [111]),
    ],
    [
      "shared-unreadable",
      new AppConfigError("duplicate-member-email", "members", "Duplicate member email."),
    ],
    [
      "shared-external-owner",
      readResult("shared-external-owner", appConfig({ members: [member(EMPLOYEE, "444")] }), [444]),
    ],
    [
      "shared-wrong-name",
      readResult("shared-wrong-name", appConfig({ members: [member(EMPLOYEE, "555")] }), [555]),
    ],
    [
      "shared-not-shared",
      readResult("shared-not-shared", appConfig({ members: [member(EMPLOYEE, "666")] }), [666]),
    ],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface Harness {
  sheets: SheetsGateway;
  drive: DriveGateway;
  config: ConfigRepository;
  validateFolder: ReturnType<typeof vi.fn>;
  listManagerFiles: ReturnType<typeof vi.fn>;
  listEmployeeCandidates: ReturnType<typeof vi.fn>;
  readOrder: string[];
  maxConcurrentReads: () => number;
}

function unsupported(name: string): never {
  throw new Error(`Discovery must not call ${name}.`);
}

function createHarness(
  options: {
    configs?: Map<string, ConfigReadResult | Error>;
    folderError?: Error;
    /** Makes the direct tab read fail, as a Sheets outage does for every file. */
    sheetsError?: Error;
  } = {},
): Harness {
  const configs = options.configs ?? defaultConfigs();
  const readOrder: string[] = [];
  let concurrent = 0;
  let peak = 0;

  const validateFolder = vi.fn(async (folderId: string) => {
    if (options.folderError) throw options.folderError;
    return { id: folderId, name: "Attendance 2026" };
  });

  const listManagerFiles = vi.fn(async (folderId: string) =>
    driveCorpus.filter((file) => file.parents.includes(folderId)).map(toSummary),
  );

  const listEmployeeCandidates = vi.fn(async () => sharedCorpus.map(toSummary));

  const drive: DriveGateway = {
    validateManagerFolder: validateFolder,
    listManagerFiles,
    listEmployeeCandidates,
    getFileAccess: () => unsupported("getFileAccess"),
    listPeople: () => unsupported("listPeople"),
    createSpreadsheetFile: () => unsupported("createSpreadsheetFile"),
    convertXlsx: () => unsupported("convertXlsx"),
    createWriterPermission: () => unsupported("createWriterPermission"),
    updateAppProperties: () => unsupported("updateAppProperties"),
  };

  const config: ConfigRepository = {
    async read(fileId) {
      readOrder.push(fileId);
      concurrent += 1;
      peak = Math.max(peak, concurrent);

      try {
        // Yield twice so any parallel read would overlap and raise the peak.
        await Promise.resolve();
        await Promise.resolve();

        const entry = configs.get(fileId);
        if (entry === undefined) throw new ConfigMissingError(fileId);
        if (entry instanceof Error) throw entry;
        return entry;
      } finally {
        concurrent -= 1;
      }
    },
    initialize: () => unsupported("config.initialize"),
    updateMemberProgress: () => unsupported("config.updateMemberProgress"),
    updateSetupState: () => unsupported("config.updateSetupState"),
  };

  const sheets = {
    async getSpreadsheet(fileId: string): Promise<SpreadsheetSnapshot> {
      if (options.sheetsError) throw options.sheetsError;
      return {
        spreadsheetId: fileId,
        sheets: [
          { sheetId: 11, title: "Tab A", index: 0, hidden: false, protectedRanges: [] },
          { sheetId: 22, title: "Tab B", index: 1, hidden: false, protectedRanges: [] },
        ],
      };
    },
    batchUpdate: () => unsupported("sheets.batchUpdate"),
    getValues: () => unsupported("sheets.getValues"),
    updateValues: () => unsupported("sheets.updateValues"),
  } as unknown as SheetsGateway;

  return {
    drive,
    config,
    sheets,
    validateFolder,
    listManagerFiles,
    listEmployeeCandidates,
    readOrder,
    maxConcurrentReads: () => peak,
  };
}

/* -------------------------------------------------------------------------- */
/* Manager discovery                                                           */
/* -------------------------------------------------------------------------- */

describe("FileDiscovery.load — manager section", () => {
  it("returns only matching owned direct children of the validated folder", async () => {
    const harness = createHarness();
    const discovery = createFileDiscovery(harness);

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed.map((file) => file.id)).toEqual(["direct-ready", "direct-legacy"]);
    expect(dashboard.managed.find((file) => file.id === "direct-legacy")?.setupState).toBe(
      "needs-setup",
    );
    expect(dashboard.managed.map((file) => file.id)).not.toContain("nested-file");
    expect(dashboard.managed.map((file) => file.id)).not.toContain("wrong-name");
    expect(dashboard.managed.map((file) => file.id)).not.toContain("not-owned");
    expect(harness.validateFolder).toHaveBeenCalledWith(FOLDER_ID);
    expect(harness.listManagerFiles).toHaveBeenCalledWith(FOLDER_ID);
  });

  it("describes a configured file with month, owner, member count, and modified time", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });
    const ready = dashboard.managed.find((file) => file.id === "direct-ready");

    expect(ready).toMatchObject({
      name: MARKER_NAME,
      ownerEmail: MANAGER,
      month: "2026-07",
      memberCount: 2,
      modifiedTime: "2026-07-30T09:00:00.000Z",
      setupState: "ready",
      error: null,
    });
  });

  it("falls back to the Drive month property for a file with no readable configuration", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });
    const legacy = dashboard.managed.find((file) => file.id === "direct-legacy");

    expect(legacy).toMatchObject({ setupState: "needs-setup", memberCount: null, month: null });
    expect(legacy?.error).toBeNull();
  });

  it("never validates or lists a folder when no folder is selected", async () => {
    const harness = createHarness();
    const discovery = createFileDiscovery(harness);

    const dashboard = await discovery.load({ actorEmail: MANAGER });

    expect(dashboard.managed).toEqual([]);
    expect(dashboard.folder).toBeNull();
    expect(dashboard.folderError).toBeNull();
    expect(harness.validateFolder).not.toHaveBeenCalled();
    expect(harness.listManagerFiles).not.toHaveBeenCalled();
    // The employee section is unaffected by the missing folder.
    expect(dashboard.timesheets.map((sheet) => sheet.id)).toContain("shared-mapped");
  });

  it("reports an unavailable folder without listing files and still returns timesheets", async () => {
    const harness = createHarness({ folderError: new FolderUnavailableError("not-found") });
    const discovery = createFileDiscovery(harness);

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed).toEqual([]);
    expect(dashboard.folder).toBeNull();
    expect(dashboard.folderError).toEqual({ reason: "not-found", message: "Folder unavailable." });
    expect(harness.listManagerFiles).not.toHaveBeenCalled();
    expect(dashboard.timesheets.map((sheet) => sheet.id)).toContain("shared-mapped");
  });

  it("returns the validated folder so the client can display its name", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.folder).toEqual({ id: FOLDER_ID, name: "Attendance 2026" });
  });

  it("turns one failed configuration read into a card-level error", async () => {
    const configs = defaultConfigs();
    configs.set("direct-ready", new GoogleApiError("Google request failed: values.batchGet."));
    const discovery = createFileDiscovery(createHarness({ configs }));

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed.map((file) => file.id)).toEqual(["direct-ready", "direct-legacy"]);
    expect(dashboard.managed[0]).toMatchObject({
      setupState: "unknown",
      error: "Could not read this file's attendance configuration.",
    });
    expect(dashboard.managed[1].setupState).toBe("needs-setup");
  });

  it("marks a structurally broken configuration as needing repair", async () => {
    const configs = defaultConfigs();
    configs.set(
      "direct-ready",
      new AppConfigError("invalid-member-row", "members", "Member row 1 has no displayName."),
    );
    const discovery = createFileDiscovery(createHarness({ configs }));

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed[0]).toMatchObject({
      setupState: "needs-repair",
      error: "This file's attendance configuration needs repair.",
    });
  });

  it("reads candidate configurations sequentially in v1", async () => {
    const harness = createHarness();
    const discovery = createFileDiscovery(harness);

    await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(harness.maxConcurrentReads()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Employee discovery                                                          */
/* -------------------------------------------------------------------------- */

describe("FileDiscovery.load — employee section", () => {
  /**
   * Every attendance file the account can reach is listed. Neither the owner's
   * domain nor `sharedWithMe` filters any more, because a shared-drive file
   * satisfies neither yet is exactly what people record hours in. Only the
   * case-sensitive name marker still decides what counts as an attendance file.
   */
  it("lists every reachable attendance file, mapped or not", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    expect(dashboard.timesheets.map((sheet) => sheet.id)).toEqual([
      "shared-mapped",
      "shared-unmapped",
      "shared-duplicate",
      "shared-missing-sheet",
      "shared-unreadable",
      "shared-external-owner",
      "shared-not-shared",
    ]);
  });

  it("still resolves the mapped tab when a configuration names one", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    expect(dashboard.timesheets[0]).toMatchObject({
      id: "shared-mapped",
      ownerEmail: "owner@blended-asia.com",
      month: "2026-07",
      sheetId: "111",
      sheetTitle: "Live 111",
    });
  });

  it.each([
    ["zero mappings", "shared-unmapped"],
    ["two mappings for the same actor", "shared-duplicate"],
    ["a mapped sheet that no longer exists", "shared-missing-sheet"],
  ])("offers a tab choice instead of refusing when the file has %s", async (_case, fileId) => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });
    const timesheet = dashboard.timesheets.find((sheet) => sheet.id === fileId);

    expect(timesheet).toMatchObject({ sheetId: null, sheetTitle: null });
    expect(timesheet?.tabs.length).toBeGreaterThan(0);
  });

  it("still excludes a name without the case-sensitive marker", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    expect(dashboard.timesheets.map((sheet) => sheet.id)).not.toContain("shared-wrong-name");
  });

  it("normalizes the actor email before matching a mapping", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: "  Employee@Blended-Asia.com  " });

    expect(dashboard.timesheets[0].sheetId).toBe("111");
  });

  it("still lists the files for an actor mapped nowhere, with no tab preselected", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: "stranger@blended-asia.com" });

    expect(dashboard.timesheets.length).toBeGreaterThan(0);
    expect(dashboard.timesheets.every((sheet) => sheet.sheetId === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Combined roles                                                              */
/* -------------------------------------------------------------------------- */

describe("FileDiscovery.load — combined roles", () => {
  it("returns managed files and timesheets for the same user", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed.map((file) => file.id)).toEqual(["direct-ready", "direct-legacy"]);
    expect(dashboard.timesheets).toContainEqual(
      expect.objectContaining({ id: "shared-mapped", sheetId: "222", sheetTitle: "Live 222" }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Files without __APP_CONFIG                                                  */
/* -------------------------------------------------------------------------- */

/** Discovery dependencies where no candidate carries a configuration sheet. */
function unconfiguredDeps(files: CorpusFile[], sheetsFail = false) {
  const drive: DriveGateway = {
    validateManagerFolder: () => unsupported("validateManagerFolder"),
    listManagerFiles: async () => [],
    listEmployeeCandidates: async () => files.map(toSummary),
    getFileAccess: () => unsupported("getFileAccess"),
    listPeople: () => unsupported("listPeople"),
    createSpreadsheetFile: () => unsupported("createSpreadsheetFile"),
    convertXlsx: () => unsupported("convertXlsx"),
    createWriterPermission: () => unsupported("createWriterPermission"),
    updateAppProperties: () => unsupported("updateAppProperties"),
  };

  const config: ConfigRepository = {
    async read(fileId) {
      throw new ConfigMissingError(fileId);
    },
    initialize: () => unsupported("config.initialize"),
    updateMemberProgress: () => unsupported("config.updateMemberProgress"),
    updateSetupState: () => unsupported("config.updateSetupState"),
  };

  const sheets = {
    async getSpreadsheet(fileId: string): Promise<SpreadsheetSnapshot> {
      if (sheetsFail) throw new GoogleApiError("Google request failed: sheets.get.", { status: 403 });

      return {
        spreadsheetId: fileId,
        sheets: [
          { sheetId: 11, title: "KIEU THU QUYNH", index: 0, hidden: false, protectedRanges: [] },
          { sheetId: 22, title: "NGUYEN PHAN LINH", index: 1, hidden: false, protectedRanges: [] },
          { sheetId: 33, title: "__APP_CONFIG", index: 2, hidden: true, protectedRanges: [] },
        ],
      };
    },
    batchUpdate: () => unsupported("sheets.batchUpdate"),
    getValues: () => unsupported("sheets.getValues"),
    updateValues: () => unsupported("sheets.updateValues"),
  } as unknown as SheetsGateway;

  return { drive, config, sheets };
}

describe("attendance files that carry no app configuration", () => {
  it("lists an unconfigured file and offers its visible tabs so the person can pick their own", async () => {
    const discovery = createFileDiscovery(
      unconfiguredDeps([
        corpusFile({ id: "plain", name: "202607勤怠管理表", ownerEmail: "boss@example.com" }),
      ]),
    );

    const { timesheets } = await discovery.load({ actorEmail: EMPLOYEE });

    expect(timesheets).toHaveLength(1);
    expect(timesheets[0]).toMatchObject({
      id: "plain",
      // No configuration means no mapping; the person chooses their own tab.
      sheetId: null,
      sheetTitle: null,
      tabs: [
        { sheetId: "11", title: "KIEU THU QUYNH" },
        { sheetId: "22", title: "NGUYEN PHAN LINH" },
      ],
    });
  });

  it("never offers the hidden configuration sheet as a tab to record hours in", async () => {
    const discovery = createFileDiscovery(
      unconfiguredDeps([corpusFile({ id: "plain", name: "202607勤怠管理表" })]),
    );

    const { timesheets } = await discovery.load({ actorEmail: EMPLOYEE });

    expect(timesheets[0].tabs.map((tab) => tab.title)).not.toContain("__APP_CONFIG");
  });

  it("does not require the owner to be in the workspace domain", async () => {
    const discovery = createFileDiscovery(
      unconfiguredDeps([
        corpusFile({ id: "outside", name: "202607勤怠管理表", ownerEmail: "boss@example.com" }),
      ]),
    );

    const { timesheets } = await discovery.load({ actorEmail: EMPLOYEE });

    expect(timesheets.map((sheet) => sheet.id)).toEqual(["outside"]);
  });

  it("takes the month from the file name when there is no configuration to read", async () => {
    const discovery = createFileDiscovery(
      unconfiguredDeps([corpusFile({ id: "plain", name: "202607勤怠管理表" })]),
    );

    const { timesheets } = await discovery.load({ actorEmail: EMPLOYEE });

    expect(timesheets[0].month).toBe("2026-07");
  });

  it("reports a file whose tabs cannot be read instead of silently dropping it", async () => {
    const discovery = createFileDiscovery(
      unconfiguredDeps([corpusFile({ id: "plain", name: "202607勤怠管理表" })], true),
    );

    const { timesheets, unreadable } = await discovery.load({ actorEmail: EMPLOYEE });

    // Still not offered as a timesheet — there is nothing to open it at.
    expect(timesheets).toEqual([]);
    // But the caller can tell "could not be read" from "you have none", which
    // is the difference between a Sheets outage and an empty Drive.
    expect(unreadable).toEqual([{ id: "plain", name: "202607勤怠管理表" }]);
  });
});

describe("FileDiscovery.load — a Sheets outage is never reported as an empty Drive", () => {
  it("names every candidate it could not read when the whole API is failing", async () => {
    const harness = createHarness({
      // No configuration anywhere, and the direct tab read fails too — exactly
      // what a disabled or throttled Sheets API looks like from here.
      configs: new Map(),
      sheetsError: new GoogleApiError("Google request failed: sheets.get.", { status: 403 }),
    });

    const { timesheets, unreadable } = await createFileDiscovery(harness).load({
      actorEmail: EMPLOYEE,
    });

    expect(timesheets).toEqual([]);
    expect(unreadable.length).toBeGreaterThan(0);
    expect(unreadable.map((file) => file.id)).toContain("shared-mapped");
  });

  it("reports nothing unreadable when every candidate reads cleanly", async () => {
    const { unreadable } = await createFileDiscovery(createHarness()).load({
      actorEmail: EMPLOYEE,
      folderId: FOLDER_ID,
    });

    expect(unreadable).toEqual([]);
  });
});
