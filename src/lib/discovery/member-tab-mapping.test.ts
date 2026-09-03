/**
 * Discovery maps the signed-in person to their own tab, from `__APP_CONFIG!H1:N`.
 *
 * Kept out of `file-discovery.test.ts` because that file is already near the
 * 800-line ceiling, and because these cases share one fixture shape that the
 * rest of discovery does not use.
 *
 * The assertions to read first are the two guards, not the happy path:
 * mapping is by EMAIL and never by a tab title that resembles a name, and a
 * configuration that cannot be read leaves the file listed and unmapped rather
 * than breaking the dashboard.
 */

import { describe, expect, it, vi } from "vitest";
import { CONFIG_MEMBER_RANGE, MEMBER_TABLE_HEADER } from "@/lib/config/schema";
import { GoogleApiError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  DriveGateway,
  SheetsGateway,
  SheetSummary,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import { createFileDiscovery } from "./file-discovery";

const ACTOR = "linh.np@blended-asia.com";
const COLLEAGUE = "quynh.ktt@blended-asia.com";
const FILE_ID = "shared-file";
const MARKER_NAME = "202607勤怠管理表";

function unsupported(name: string): never {
  throw new Error(`Discovery must not call ${name}.`);
}

/** The tabs a real supplied workbook has: people by name, plus the hidden config. */
const DEFAULT_TABS: SheetSummary[] = [
  { sheetId: 11, title: "KIEU THU QUYNH", index: 0, hidden: false, protectedRanges: [] },
  { sheetId: 22, title: "NGUYEN PHAN LINH", index: 1, hidden: false, protectedRanges: [] },
  { sheetId: 33, title: "__APP_CONFIG", index: 2, hidden: true, protectedRanges: [] },
];

const HEADER = [...MEMBER_TABLE_HEADER] as string[];

function memberRow(displayName: string, email: string, sheetId: string, sheetTitle: string) {
  // displayName, email, sheetId, sheetTitle, protectionId, permissionId, setupStatus
  return [displayName, email, sheetId, sheetTitle, "", "", "ready"];
}

interface Options {
  /** Raw `H1:N` rows, header included. Omit for a file with no member table. */
  members?: string[][];
  tabs?: SheetSummary[];
  getValuesError?: Error;
}

function deps(options: Options = {}) {
  const file: AttendanceFileSummary = {
    id: FILE_ID,
    name: MARKER_NAME,
    ownedByMe: false,
    sharedWithMe: false,
    ownerEmail: "boss@blended-asia.com",
    appProperties: {},
    modifiedTime: null,
  };

  const getValues = vi.fn(async (_fileId: string, ranges: string[]) => {
    if (options.getValuesError) throw options.getValuesError;
    return ranges.map((range) => ({ range, values: options.members ?? [] }));
  });

  const drive: DriveGateway = {
    validateManagerFolder: () => unsupported("validateManagerFolder"),
    listManagerFiles: async () => [],
    listEmployeeCandidates: async () => [file],
    getFileAccess: () => unsupported("getFileAccess"),
    listPeople: () => unsupported("listPeople"),
    createSpreadsheetFile: () => unsupported("createSpreadsheetFile"),
    convertXlsx: () => unsupported("convertXlsx"),
    createWriterPermission: () => unsupported("createWriterPermission"),
    updateAppProperties: () => unsupported("updateAppProperties"),
  };

  const sheets = {
    async getSpreadsheet(fileId: string): Promise<SpreadsheetSnapshot> {
      return { spreadsheetId: fileId, sheets: options.tabs ?? DEFAULT_TABS };
    },
    batchUpdate: () => unsupported("sheets.batchUpdate"),
    getValues,
    updateValues: () => unsupported("sheets.updateValues"),
  } as unknown as SheetsGateway;

  return { drive, sheets, getValues };
}

/* -------------------------------------------------------------------------- */

describe("discovery maps a person to their own tab", () => {
  it("preselects the tab whose member row carries the actor's email", async () => {
    const { drive, sheets } = deps({
      members: [
        HEADER,
        memberRow("Kieu Thu Quynh", COLLEAGUE, "11", "KIEU THU QUYNH"),
        memberRow("Nguyen Phan Linh", ACTOR, "22", "NGUYEN PHAN LINH"),
      ],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]).toMatchObject({
      id: FILE_ID,
      sheetId: "22",
      sheetTitle: "NGUYEN PHAN LINH",
    });
  });

  it("compares emails case-insensitively, as the sheet stores them normalized", async () => {
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", "LINH.NP@Blended-Asia.com", "22", "NGUYEN PHAN LINH")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetId).toBe("22");
  });

  it("still offers every visible tab alongside the mapping, so the person can override it", async () => {
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", ACTOR, "22", "NGUYEN PHAN LINH")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.tabs).toEqual([
      { sheetId: "11", title: "KIEU THU QUYNH" },
      { sheetId: "22", title: "NGUYEN PHAN LINH" },
    ]);
  });
});

describe("the guards that keep the mapping from opening the wrong tab", () => {
  /*
   * The invariant this protects: a tab title is never evidence of whose tab it
   * is. The actor's display name is literally a tab here, and there is no
   * member row for them — the answer must still be "pick one", because the day
   * two colleagues share a name, guessing opens the wrong person's hours.
   */
  it("never matches a tab title against the actor's name", async () => {
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Kieu Thu Quynh", COLLEAGUE, "11", "KIEU THU QUYNH")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetId).toBeNull();
    expect(timesheets[0]?.sheetTitle).toBeNull();
  });

  it("leaves the mapping null when the members table has no row for the actor", async () => {
    const { drive, sheets } = deps({ members: [HEADER] });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetId).toBeNull();
  });

  it("refuses a mapping onto the hidden configuration sheet", async () => {
    // A save against __APP_CONFIG would write attendance columns over the
    // settings table, so a row pointing there is treated as no mapping at all.
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", ACTOR, "33", "__APP_CONFIG")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetId).toBeNull();
  });

  it("drops a mapping whose tab no longer exists in the file", async () => {
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", ACTOR, "99", "DELETED TAB")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetId).toBeNull();
  });

  it("trusts the file's own tab list over the stored title", async () => {
    // The sheet stores IDs precisely because a tab can be renamed; the title in
    // the member row is a stale label, not the identity.
    const { drive, sheets } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", ACTOR, "22", "OLD NAME")],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(timesheets[0]?.sheetTitle).toBe("NGUYEN PHAN LINH");
  });
});

describe("the mapping never costs more than it has to, and never breaks the dashboard", () => {
  it("does not open a configuration sheet for a file that has none", async () => {
    // The tab list already says whether __APP_CONFIG exists, so a file without
    // one costs zero extra calls — the measured objection that removed this
    // feature in the first place.
    const { drive, sheets, getValues } = deps({
      tabs: [{ sheetId: 11, title: "Tab A", index: 0, hidden: false, protectedRanges: [] }],
    });

    const { timesheets } = await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(getValues).not.toHaveBeenCalled();
    expect(timesheets[0]?.sheetId).toBeNull();
  });

  it("reads only the member range, never the whole configuration", async () => {
    const { drive, sheets, getValues } = deps({
      members: [HEADER, memberRow("Nguyen Phan Linh", ACTOR, "22", "NGUYEN PHAN LINH")],
    });

    await createFileDiscovery({ drive, sheets }).load({ actorEmail: ACTOR });

    expect(getValues).toHaveBeenCalledWith(FILE_ID, [CONFIG_MEMBER_RANGE]);
  });

  it("lists the file unmapped, not unreadable, when the member range cannot be read", async () => {
    const { drive, sheets } = deps({
      getValuesError: new GoogleApiError("Google request failed: sheets.getValues.", { status: 403 }),
    });

    const { timesheets, unreadable } = await createFileDiscovery({ drive, sheets }).load({
      actorEmail: ACTOR,
    });

    // A configuration that cannot be read is not a file that cannot be opened:
    // the person can still pick a tab and record hours.
    expect(unreadable).toEqual([]);
    expect(timesheets[0]).toMatchObject({ id: FILE_ID, sheetId: null });
    expect(timesheets[0]?.tabs).toHaveLength(2);
  });

  it("degrades to no mapping when the members table is malformed", async () => {
    // Two rows claiming the same email is exactly what parseAppConfig rejects.
    // A manager's typo must not take the calendar down for everyone.
    const { drive, sheets } = deps({
      members: [
        HEADER,
        memberRow("Nguyen Phan Linh", ACTOR, "11", "KIEU THU QUYNH"),
        memberRow("Someone Else", ACTOR, "22", "NGUYEN PHAN LINH"),
      ],
    });

    const { timesheets, unreadable } = await createFileDiscovery({ drive, sheets }).load({
      actorEmail: ACTOR,
    });

    expect(unreadable).toEqual([]);
    expect(timesheets[0]?.sheetId).toBeNull();
  });
});
