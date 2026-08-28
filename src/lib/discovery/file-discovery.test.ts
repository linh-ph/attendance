import { describe, expect, it, vi } from "vitest";
import { ConfigMissingError, type ConfigReadResult, type ConfigRepository } from "@/lib/config/repository";
import { AppConfigError, type AppConfig } from "@/lib/config/schema";
import { FolderUnavailableError, GoogleApiError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  DriveGateway,
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

  return {
    drive,
    config,
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
    expect(dashboard.timesheets.map((sheet) => sheet.id)).toEqual(["shared-mapped"]);
  });

  it("reports an unavailable folder without listing files and still returns timesheets", async () => {
    const harness = createHarness({ folderError: new FolderUnavailableError("not-found") });
    const discovery = createFileDiscovery(harness);

    const dashboard = await discovery.load({ actorEmail: MANAGER, folderId: FOLDER_ID });

    expect(dashboard.managed).toEqual([]);
    expect(dashboard.folder).toBeNull();
    expect(dashboard.folderError).toEqual({ reason: "not-found", message: "Folder unavailable." });
    expect(harness.listManagerFiles).not.toHaveBeenCalled();
    expect(dashboard.timesheets.map((sheet) => sheet.id)).toEqual(["shared-mapped"]);
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
  it("includes only a shared in-domain file with exactly one valid mapping", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    expect(dashboard.timesheets).toEqual([
      {
        id: "shared-mapped",
        name: MARKER_NAME,
        ownerEmail: "owner@blended-asia.com",
        month: "2026-07",
        modifiedTime: "2026-07-29T01:02:03.000Z",
        sheetId: "111",
        sheetTitle: "Live 111",
      },
    ]);
  });

  it.each([
    ["zero mappings", "shared-unmapped"],
    ["two mappings for the same actor", "shared-duplicate"],
    ["a mapped sheet that no longer exists", "shared-missing-sheet"],
    ["an unreadable configuration", "shared-unreadable"],
    ["an owner outside the workspace domain", "shared-external-owner"],
    ["a name without the case-sensitive marker", "shared-wrong-name"],
    ["a file Drive does not report as shared with me", "shared-not-shared"],
  ])("excludes a shared file with %s", async (_description, excludedId) => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    expect(dashboard.timesheets.map((sheet) => sheet.id)).not.toContain(excludedId);
  });

  it("compares the owner domain case-insensitively", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: EMPLOYEE });

    // `shared-mapped` is owned by `Owner@Blended-Asia.COM`.
    expect(dashboard.timesheets.map((sheet) => sheet.id)).toContain("shared-mapped");
  });

  it("normalizes the actor email before matching a mapping", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: "  Employee@Blended-Asia.com  " });

    expect(dashboard.timesheets.map((sheet) => sheet.sheetId)).toEqual(["111"]);
  });

  it("returns no timesheets for an actor with no mapping anywhere", async () => {
    const discovery = createFileDiscovery(createHarness());

    const dashboard = await discovery.load({ actorEmail: "stranger@blended-asia.com" });

    expect(dashboard.timesheets).toEqual([]);
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
    expect(dashboard.timesheets).toEqual([
      expect.objectContaining({ id: "shared-mapped", sheetId: "222", sheetTitle: "Live 222" }),
    ]);
  });
});
