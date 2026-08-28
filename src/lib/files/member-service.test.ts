import { describe, expect, it } from "vitest";
import {
  MemberServiceError,
  createMemberService,
  type MemberService,
  type MemberServiceDependencies,
} from "./member-service";
import type {
  ConfigReadResult,
  ConfigRepository,
  MemberProgressUpdate,
} from "@/lib/config/repository";
import { normalizeEmail, type AppConfig, type ConfigMember } from "@/lib/config/schema";
import { GoogleApiError } from "@/lib/google/errors";
import type {
  BatchUpdateResult,
  DriveFileAccess,
  DriveGateway,
  SheetRequest,
  SheetSummary,
  SheetsGateway,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import { TEMPLATE_VERSION } from "@/lib/workbook/template";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MANAGER = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const STRANGER = "stranger@blended-asia.com";
const NEW_MEMBER = "new@blended-asia.com";

const CONFIG_SHEET_ID = 900;
const EXISTING_SHEET_ID = 123;
const NEXT_SHEET_ID = 200;
const NEXT_PROTECTION_ID = 700;

function existingMember(): ConfigMember {
  return {
    displayName: "Linh",
    email: EMPLOYEE_A,
    sheetId: String(EXISTING_SHEET_ID),
    sheetTitle: "Linh",
    protectionId: "456",
    permissionId: "perm-a",
    setupStatus: "ready",
  };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    schemaVersion: 1,
    setupState: "ready",
    month: "2026-07",
    ownerEmail: MANAGER,
    templateVersion: TEMPLATE_VERSION,
    statuses: [
      { code: "office", labelEn: "Office", sheetValue: "出社" },
      { code: "remote", labelEn: "Remote", sheetValue: "リモート" },
    ],
    members: [existingMember()],
    ...overrides,
  };
}

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

/* -------------------------------------------------------------------------- */
/* Local fake Google boundary                                                  */
/* -------------------------------------------------------------------------- */

interface FakeGoogleOptions {
  config?: AppConfig;
  access?: DriveFileAccess;
  /** Normalized emails whose Drive invitation must fail. */
  failInvitations?: string[];
}

interface FakeGoogle extends MemberServiceDependencies {
  /** Mutation log only. A read never appends to it. */
  events: string[];
  /** Separate read log, so "no mutation" assertions stay literal. */
  reads: string[];
  members(): ConfigMember[];
  sheetTitles(): string[];
  failInvitations: Set<string>;
}

function unused(name: string) {
  return (): never => {
    throw new Error(`unexpected call to ${name}`);
  };
}

function mergeMember(current: ConfigMember, update: MemberProgressUpdate): ConfigMember {
  const resource = (value: string | number | null | undefined): string | null =>
    value === null || value === undefined || value === "" ? null : String(value);

  return {
    displayName: update.displayName ?? current.displayName,
    email: current.email,
    sheetId: update.sheetId === undefined ? current.sheetId : resource(update.sheetId),
    sheetTitle: update.sheetTitle === undefined ? current.sheetTitle : update.sheetTitle,
    protectionId:
      update.protectionId === undefined ? current.protectionId : resource(update.protectionId),
    permissionId: update.permissionId === undefined ? current.permissionId : update.permissionId,
    setupStatus: update.setupStatus ?? current.setupStatus,
  };
}

function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const events: string[] = [];
  const reads: string[] = [];
  const failInvitations = new Set((options.failInvitations ?? []).map(normalizeEmail));

  let config: AppConfig = options.config ?? appConfig();
  let nextSheetId = NEXT_SHEET_ID;
  let nextProtectionId = NEXT_PROTECTION_ID;

  const sheets: SheetSummary[] = [
    { sheetId: CONFIG_SHEET_ID, title: "__APP_CONFIG", index: 0, hidden: true, protectedRanges: [] },
    {
      sheetId: EXISTING_SHEET_ID,
      title: "Linh",
      index: 1,
      hidden: false,
      protectedRanges: [{ protectedRangeId: 456, sheetId: EXISTING_SHEET_ID }],
    },
  ];

  function snapshot(): SpreadsheetSnapshot {
    return { spreadsheetId: "file-1", sheets: sheets.map((sheet) => ({ ...sheet })) };
  }

  const drive: DriveGateway = {
    validateManagerFolder: unused("validateManagerFolder"),
    listManagerFiles: unused("listManagerFiles"),
    listEmployeeCandidates: unused("listEmployeeCandidates"),
    createSpreadsheetFile: unused("createSpreadsheetFile"),
    convertXlsx: unused("convertXlsx"),
    async getFileAccess(fileId) {
      reads.push(`get-file-access:${fileId}`);
      return options.access ?? driveAccess();
    },
    async createWriterPermission(_fileId, email) {
      const normalized = normalizeEmail(email);
      events.push(`invite:${normalized}`);
      if (failInvitations.has(normalized)) {
        throw new GoogleApiError("Google request failed: create permission.");
      }
      return `perm-${normalized}`;
    },
    async updateAppProperties(fileId, properties) {
      events.push(`set-app-properties:${fileId}:${JSON.stringify(properties)}`);
    },
  };

  const sheetsGateway: SheetsGateway = {
    async getSpreadsheet(fileId) {
      reads.push(`get-spreadsheet:${fileId}`);
      return snapshot();
    },
    async getValues(fileId, ranges) {
      reads.push(`get-values:${fileId}:${ranges.join(",")}`);
      return [];
    },
    updateValues: unused("updateValues"),
    async batchUpdate(_fileId, requests: SheetRequest[]): Promise<BatchUpdateResult> {
      const first = requests.at(0) ?? {};

      if ("addSheet" in first) {
        const title = (first.addSheet as { properties: { title: string } }).properties.title;
        const sheetId = nextSheetId;
        nextSheetId += 1;
        sheets.push({
          sheetId,
          title,
          index: sheets.length,
          hidden: false,
          protectedRanges: [],
        });
        events.push(`add-sheet:${title}`);
        return { spreadsheetId: "file-1", replies: [{ addSheet: { sheetId, title } }] };
      }

      if ("addProtectedRange" in first) {
        const request = first.addProtectedRange as {
          protectedRange: { range: { sheetId: number }; editors: { users: string[] } };
        };
        const sheetId = request.protectedRange.range.sheetId;
        const protectedRangeId = nextProtectionId;
        nextProtectionId += 1;
        const target = sheets.find((sheet) => sheet.sheetId === sheetId);
        target?.protectedRanges.push({ protectedRangeId, sheetId });
        events.push(
          `protect-sheet:${sheetId}:${request.protectedRange.editors.users.join("|")}`,
        );
        return { spreadsheetId: "file-1", replies: [{ addProtectedRange: { protectedRangeId } }] };
      }

      const target = requests.find((request) => "updateSheetProperties" in request) as
        | {
            updateSheetProperties: {
              properties: { sheetId: number; gridProperties: { rowCount: number } };
            };
          }
        | undefined;
      const properties = target?.updateSheetProperties.properties;
      // The row count encodes the month the template was generated for.
      events.push(`apply-template:${properties?.sheetId ?? "?"}:rows=${
        properties?.gridProperties.rowCount ?? "?"
      }`);
      return { spreadsheetId: "file-1", replies: [] };
    },
  };

  const configRepository: ConfigRepository = {
    initialize: unused("initialize"),
    updateSetupState: unused("updateSetupState"),
    async read(fileId): Promise<ConfigReadResult> {
      reads.push(`read-config:${fileId}`);
      return {
        fileId,
        config: structuredClone(config),
        configSheetId: CONFIG_SHEET_ID,
        spreadsheet: snapshot(),
      };
    },
    async updateMemberProgress(_fileId, update) {
      const email = normalizeEmail(update.email);
      const index = config.members.findIndex((member) => member.email === email);
      const base: ConfigMember =
        index === -1
          ? {
              displayName: "",
              email,
              sheetId: null,
              sheetTitle: null,
              protectionId: null,
              permissionId: null,
              setupStatus: "",
            }
          : config.members[index];
      const next = mergeMember(base, update);

      config = {
        ...config,
        members:
          index === -1
            ? [...config.members, next]
            : config.members.map((member, position) => (position === index ? next : member)),
      };

      events.push(`write-member:${email}:${next.setupStatus}`);
      return next;
    },
  };

  return {
    drive,
    sheets: sheetsGateway,
    config: configRepository,
    events,
    reads,
    failInvitations,
    members: () => config.members.map((member) => ({ ...member })),
    sheetTitles: () => sheets.map((sheet) => sheet.title),
  };
}

function createService(fake: FakeGoogle): MemberService {
  return createMemberService({ drive: fake.drive, sheets: fake.sheets, config: fake.config });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("memberService.addMember", () => {
  it("creates one employee sheet, template, protection, config row, and writer permission", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    const result = await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "  New Person  ",
      email: "  New@Blended-Asia.COM  ",
    });

    expect(fakeGoogle.events).toEqual([
      "add-sheet:New Person",
      `apply-template:${NEXT_SHEET_ID}:rows=34`,
      `protect-sheet:${NEXT_SHEET_ID}:${MANAGER}|${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:pending`,
      `invite:${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:ready`,
    ]);

    expect(result).toEqual({
      fileId: "file-1",
      invitationFailed: false,
      member: {
        displayName: "New Person",
        email: NEW_MEMBER,
        sheetId: String(NEXT_SHEET_ID),
        sheetTitle: "New Person",
        setupStatus: "ready",
        invitationSent: true,
      },
    });

    expect(fakeGoogle.sheetTitles()).toContain("New Person");
    expect(fakeGoogle.members().at(-1)).toEqual({
      displayName: "New Person",
      email: NEW_MEMBER,
      sheetId: String(NEXT_SHEET_ID),
      sheetTitle: "New Person",
      protectionId: String(NEXT_PROTECTION_ID),
      permissionId: `perm-${NEW_MEMBER}`,
      setupStatus: "ready",
    });
  });

  it("builds the new tab from the month stored in the protected config", async () => {
    const fakeGoogle = createFakeGoogle({ config: appConfig({ month: "2026-02" }) });
    const service = createService(fakeGoogle);

    await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "New Person",
      email: NEW_MEMBER,
    });

    // February 2026 has 28 day rows below the 3 header rows; the month is never
    // taken from the request and never inferred from the file name.
    expect(fakeGoogle.events).toContain(`apply-template:${NEXT_SHEET_ID}:rows=31`);
  });

  it("rejects an employee before any mutation", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: "employee@blended-asia.com",
        displayName: "New Person",
        email: "new@blended-asia.com",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("rejects a mapped employee of the same file before any mutation", async () => {
    const fakeGoogle = createFakeGoogle({
      access: driveAccess({ ownedByMe: false, ownerEmail: MANAGER }),
    });
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: EMPLOYEE_A,
        displayName: "New Person",
        email: NEW_MEMBER,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("rejects a signed-in stranger before any mutation", async () => {
    const fakeGoogle = createFakeGoogle({
      access: driveAccess({ ownedByMe: false, ownerEmail: MANAGER }),
    });
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: STRANGER,
        displayName: "New Person",
        email: NEW_MEMBER,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("returns 409-shaped member-exists for an email already mapped, whatever its case", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: MANAGER,
        displayName: "Different Name",
        email: "Employee-A@Blended-Asia.com",
      }),
    ).rejects.toMatchObject({ code: "member-exists" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("returns 409-shaped sheet-title-conflict for a display name that already has a tab", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: MANAGER,
        displayName: "  linh ",
        email: NEW_MEMBER,
      }),
    ).rejects.toMatchObject({ code: "sheet-title-conflict" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("rejects an empty display name and an invalid email before any mutation", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: MANAGER,
        displayName: "   ",
        email: NEW_MEMBER,
      }),
    ).rejects.toBeInstanceOf(MemberServiceError);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: MANAGER,
        displayName: "New Person",
        email: "not-an-email",
      }),
    ).rejects.toMatchObject({ code: "invalid-member" });

    expect(fakeGoogle.events).toEqual([]);
  });

  it("refuses to add a tab to a file built by a different template version", async () => {
    const fakeGoogle = createFakeGoogle({
      config: appConfig({ templateVersion: TEMPLATE_VERSION + 1 }),
    });
    const service = createService(fakeGoogle);

    await expect(
      service.addMember({
        fileId: "file-1",
        actorEmail: MANAGER,
        displayName: "New Person",
        email: NEW_MEMBER,
      }),
    ).rejects.toMatchObject({ code: "template-version-unsupported" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("retains the created sheet and protection when the invitation fails", async () => {
    const fakeGoogle = createFakeGoogle({ failInvitations: [NEW_MEMBER] });
    const service = createService(fakeGoogle);

    const result = await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "New Person",
      email: NEW_MEMBER,
    });

    expect(fakeGoogle.events).toEqual([
      "add-sheet:New Person",
      `apply-template:${NEXT_SHEET_ID}:rows=34`,
      `protect-sheet:${NEXT_SHEET_ID}:${MANAGER}|${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:pending`,
      `invite:${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:invite-failed`,
    ]);

    expect(result.invitationFailed).toBe(true);
    expect(result.member).toEqual({
      displayName: "New Person",
      email: NEW_MEMBER,
      sheetId: String(NEXT_SHEET_ID),
      sheetTitle: "New Person",
      setupStatus: "invite-failed",
      invitationSent: false,
    });
    expect(fakeGoogle.members().at(-1)?.protectionId).toBe(String(NEXT_PROTECTION_ID));
  });
});

describe("memberService.retryInvitation", () => {
  it("invites only the failed email and never recreates the tab or protection", async () => {
    const fakeGoogle = createFakeGoogle({ failInvitations: [NEW_MEMBER] });
    const service = createService(fakeGoogle);

    await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "New Person",
      email: NEW_MEMBER,
    });

    fakeGoogle.failInvitations.delete(NEW_MEMBER);
    fakeGoogle.events.length = 0;

    const result = await service.retryInvitation({
      fileId: "file-1",
      actorEmail: MANAGER,
      email: "New@Blended-Asia.com",
    });

    expect(fakeGoogle.events).toEqual([
      `invite:${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:ready`,
    ]);
    expect(result.invitationFailed).toBe(false);
    expect(result.member.setupStatus).toBe("ready");
    expect(result.member.sheetId).toBe(String(NEXT_SHEET_ID));
    expect(fakeGoogle.sheetTitles().filter((title) => title === "New Person")).toHaveLength(1);
  });

  it("records invite-failed again when the retried invitation still fails", async () => {
    const fakeGoogle = createFakeGoogle({ failInvitations: [NEW_MEMBER] });
    const service = createService(fakeGoogle);

    await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "New Person",
      email: NEW_MEMBER,
    });
    fakeGoogle.events.length = 0;

    const result = await service.retryInvitation({
      fileId: "file-1",
      actorEmail: MANAGER,
      email: NEW_MEMBER,
    });

    expect(result.invitationFailed).toBe(true);
    expect(fakeGoogle.events).toEqual([
      `invite:${NEW_MEMBER}`,
      `write-member:${NEW_MEMBER}:invite-failed`,
    ]);
  });

  it("does not create a second Drive permission for an already invited member", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    const result = await service.retryInvitation({
      fileId: "file-1",
      actorEmail: MANAGER,
      email: EMPLOYEE_A,
    });

    expect(fakeGoogle.events).toEqual([]);
    expect(result.invitationFailed).toBe(false);
    expect(result.member.setupStatus).toBe("ready");
  });

  it("rejects an email that is not a member of the file", async () => {
    const fakeGoogle = createFakeGoogle();
    const service = createService(fakeGoogle);

    await expect(
      service.retryInvitation({
        fileId: "file-1",
        actorEmail: MANAGER,
        email: STRANGER,
      }),
    ).rejects.toMatchObject({ code: "member-not-found" });
    expect(fakeGoogle.events).toEqual([]);
  });

  it("rejects an employee before any mutation", async () => {
    const fakeGoogle = createFakeGoogle({
      access: driveAccess({ ownedByMe: false, ownerEmail: MANAGER }),
    });
    const service = createService(fakeGoogle);

    await expect(
      service.retryInvitation({
        fileId: "file-1",
        actorEmail: EMPLOYEE_A,
        email: EMPLOYEE_A,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeGoogle.events).toEqual([]);
  });
});

describe("memberService.listMembers", () => {
  it("returns the month and every member with its stored setup status", async () => {
    const fakeGoogle = createFakeGoogle({ failInvitations: [NEW_MEMBER] });
    const service = createService(fakeGoogle);

    await service.addMember({
      fileId: "file-1",
      actorEmail: MANAGER,
      displayName: "New Person",
      email: NEW_MEMBER,
    });

    await expect(
      service.listMembers({ fileId: "file-1", actorEmail: "Manager@Blended-Asia.com" }),
    ).resolves.toEqual({
      fileId: "file-1",
      month: "2026-07",
      members: [
        {
          displayName: "Linh",
          email: EMPLOYEE_A,
          sheetId: String(EXISTING_SHEET_ID),
          sheetTitle: "Linh",
          setupStatus: "ready",
          invitationSent: true,
        },
        {
          displayName: "New Person",
          email: NEW_MEMBER,
          sheetId: String(NEXT_SHEET_ID),
          sheetTitle: "New Person",
          setupStatus: "invite-failed",
          invitationSent: false,
        },
      ],
    });
  });

  it("never lists members to an employee", async () => {
    const fakeGoogle = createFakeGoogle({
      access: driveAccess({ ownedByMe: false, ownerEmail: MANAGER }),
    });
    const service = createService(fakeGoogle);

    await expect(
      service.listMembers({ fileId: "file-1", actorEmail: EMPLOYEE_A }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fakeGoogle.events).toEqual([]);
  });
});
