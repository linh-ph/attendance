import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { FolderUnavailableError, GoogleApiError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  DriveGateway,
  RangeValues,
  SheetsGateway,
  SpreadsheetSnapshot,
} from "@/lib/google/types";

vi.mock("@/lib/google/client", () => ({ createGoogleGateways: vi.fn() }));

import { createGoogleGateways } from "@/lib/google/client";
import { GET } from "./route";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const BASE_URL = "http://attendance.test/api/dashboard";

const MANAGER = "manager@blended-asia.com";
const EMPLOYEE = "employee@blended-asia.com";
const FOLDER_ID = "folder-1";
const MARKER_NAME = "202607勤怠管理表";

const gateways = vi.mocked(createGoogleGateways);

/* -------------------------------------------------------------------------- */
/* Session helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signedRequest(url: string, email = MANAGER): Promise<Request> {
  const encrypted = await encode({
    secret: SECRET,
    salt: COOKIE_NAME,
    token: { email, accessToken: "provider-access-token" },
  });

  return new Request(url, { headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(encrypted)}` } });
}

/* -------------------------------------------------------------------------- */
/* Google fakes (real config repository runs on top of these)                  */
/* -------------------------------------------------------------------------- */

function summary(overrides: Partial<AttendanceFileSummary> & { id: string }): AttendanceFileSummary {
  return {
    name: MARKER_NAME,
    ownedByMe: false,
    sharedWithMe: false,
    ownerEmail: null,
    appProperties: {},
    modifiedTime: null,
    ...overrides,
  };
}

interface SheetFixture {
  sheetId: number;
  title: string;
}

interface FileFixture {
  sheets: SheetFixture[];
  settings?: string[][];
  statuses?: string[][];
  members?: string[][];
}

const CONFIG_SHEET: SheetFixture = { sheetId: 0, title: "__APP_CONFIG" };

const DEFAULT_SETTINGS: string[][] = [
  ["schemaVersion", "1"],
  ["setupState", "ready"],
  ["month", "2026-07"],
  ["ownerEmail", MANAGER],
  ["templateVersion", "1"],
];

const DEFAULT_STATUSES: string[][] = [
  ["code", "labelEn", "sheetValue"],
  ["work", "Work", "出勤"],
];

const MEMBER_HEADER = [
  "displayName",
  "email",
  "sheetId",
  "sheetTitle",
  "protectionId",
  "permissionId",
  "setupStatus",
];

const fileFixtures = new Map<string, FileFixture>([
  [
    "owned-ready",
    {
      sheets: [CONFIG_SHEET, { sheetId: 111, title: "Employee A" }],
      members: [
        MEMBER_HEADER,
        ["Employee A", EMPLOYEE, "111", "Employee A", "9", "p1", "ready"],
      ],
    },
  ],
  // No `__APP_CONFIG` sheet at all: a legacy attendance workbook.
  ["owned-legacy", { sheets: [{ sheetId: 5, title: "Sheet1" }] }],
  [
    "shared-file",
    {
      sheets: [
        CONFIG_SHEET,
        { sheetId: 111, title: "Employee A" },
        { sheetId: 222, title: "Manager" },
      ],
      settings: [
        ["schemaVersion", "1"],
        ["setupState", "ready"],
        ["month", "2026-07"],
        ["ownerEmail", "owner@blended-asia.com"],
        ["templateVersion", "1"],
      ],
      members: [
        MEMBER_HEADER,
        ["Employee A", EMPLOYEE, "111", "Employee A", "9", "p1", "ready"],
        ["Manager", MANAGER, "222", "Manager", "10", "p2", "ready"],
      ],
    },
  ],
]);

function toSnapshot(fileId: string): SpreadsheetSnapshot {
  const fixture = fileFixtures.get(fileId);
  return {
    spreadsheetId: fileId,
    sheets: (fixture?.sheets ?? []).map((sheet, index) => ({
      ...sheet,
      index,
      hidden: sheet.title === CONFIG_SHEET.title,
      protectedRanges: [],
    })),
  };
}

function toValues(fileId: string, ranges: string[]): RangeValues[] {
  const fixture = fileFixtures.get(fileId);
  const tables = [
    fixture?.settings ?? DEFAULT_SETTINGS,
    fixture?.statuses ?? DEFAULT_STATUSES,
    fixture?.members ?? [MEMBER_HEADER],
  ];

  return ranges.map((range, index) => ({ range, values: tables[index] ?? [] }));
}

interface Fakes {
  drive: DriveGateway;
  sheets: SheetsGateway;
  validateFolder: ReturnType<typeof vi.fn>;
  listManagerFiles: ReturnType<typeof vi.fn>;
}

function unsupported(name: string): never {
  throw new Error(`The dashboard route must not call ${name}.`);
}

function installFakes(options: { folderError?: Error; listError?: Error } = {}): Fakes {
  const validateFolder = vi.fn(async (folderId: string) => {
    if (options.folderError) throw options.folderError;
    return { id: folderId, name: "Attendance 2026" };
  });

  const listManagerFiles = vi.fn(async () => {
    if (options.listError) throw options.listError;
    return [
      summary({
        id: "owned-ready",
        ownedByMe: true,
        ownerEmail: MANAGER,
        modifiedTime: "2026-07-30T09:00:00.000Z",
      }),
      summary({ id: "owned-legacy", name: "202605勤怠管理表", ownedByMe: true, ownerEmail: MANAGER }),
      summary({ id: "not-attendance", name: "Budget", ownedByMe: true, ownerEmail: MANAGER }),
    ];
  });

  const drive: DriveGateway = {
    validateManagerFolder: validateFolder,
    listManagerFiles,
    listEmployeeCandidates: vi.fn(async () => [
      summary({
        id: "shared-file",
        sharedWithMe: true,
        ownerEmail: "Owner@Blended-Asia.com",
        modifiedTime: "2026-07-29T01:02:03.000Z",
      }),
    ]),
    getFileAccess: () => unsupported("getFileAccess"),
    createSpreadsheetFile: () => unsupported("createSpreadsheetFile"),
    convertXlsx: () => unsupported("convertXlsx"),
    createWriterPermission: () => unsupported("createWriterPermission"),
    updateAppProperties: () => unsupported("updateAppProperties"),
  };

  const sheets: SheetsGateway = {
    getSpreadsheet: async (fileId) => toSnapshot(fileId),
    getValues: async (fileId, ranges) => toValues(fileId, ranges),
    batchUpdate: () => unsupported("batchUpdate"),
    updateValues: () => unsupported("updateValues"),
  };

  gateways.mockReturnValue({ drive, sheets });

  return { drive, sheets, validateFolder, listManagerFiles };
}

interface DashboardBody {
  managed: { id: string; setupState: string; memberCount: number | null }[];
  timesheets: { id: string; sheetId: string }[];
  folderError?: string;
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("GET /api/dashboard", () => {
  it("returns folder-scoped managed files and the actor's timesheets", async () => {
    const fakes = installFakes();

    const response = await GET(await signedRequest(`${BASE_URL}?folderId=${FOLDER_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as DashboardBody;
    expect(body.managed.map((file) => file.id)).toEqual(["owned-ready", "owned-legacy"]);
    expect(body.managed[0]).toMatchObject({ setupState: "ready", memberCount: 1 });
    expect(body.managed[1]).toMatchObject({ setupState: "needs-setup", memberCount: null });
    expect(body.timesheets).toEqual([
      expect.objectContaining({ id: "shared-file", sheetId: "222", sheetTitle: "Manager" }),
    ]);
    expect(body).not.toHaveProperty("folderError");
    expect(fakes.validateFolder).toHaveBeenCalledWith(FOLDER_ID);
  });

  it("ignores a client-supplied email and re-derives the actor from the session", async () => {
    installFakes();

    const response = await GET(
      await signedRequest(`${BASE_URL}?folderId=${FOLDER_ID}&email=${EMPLOYEE}&actorEmail=${EMPLOYEE}`),
    );

    const body = (await response.json()) as DashboardBody;
    // Sheet 222 is the session manager's mapping; 111 belongs to the spoofed email.
    expect(body.timesheets.map((sheet) => sheet.sheetId)).toEqual(["222"]);
  });

  it("rejects an anonymous request before touching Google", async () => {
    installFakes();

    const response = await GET(new Request(`${BASE_URL}?folderId=${FOLDER_ID}`));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
    expect(gateways).not.toHaveBeenCalled();
  });

  it("returns timesheets without scanning Drive when no folder is selected", async () => {
    const fakes = installFakes();

    const response = await GET(await signedRequest(BASE_URL));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardBody;
    expect(body.managed).toEqual([]);
    expect(body.timesheets).toHaveLength(1);
    expect(fakes.validateFolder).not.toHaveBeenCalled();
    expect(fakes.listManagerFiles).not.toHaveBeenCalled();
  });

  it.each([
    ["not-found", 404],
    ["not-owned", 403],
    ["not-writable", 403],
    ["shared-drive", 403],
    ["trashed", 422],
    ["not-a-folder", 422],
  ])("answers a %s folder with status %i and keeps the employee section", async (reason, status) => {
    const fakes = installFakes({ folderError: new FolderUnavailableError(reason) });

    const response = await GET(await signedRequest(`${BASE_URL}?folderId=${FOLDER_ID}`));

    expect(response.status).toBe(status);
    const body = (await response.json()) as DashboardBody;
    expect(body.folderError).toBe("Folder unavailable.");
    expect(body.managed).toEqual([]);
    expect(body.timesheets).toHaveLength(1);
    expect(fakes.listManagerFiles).not.toHaveBeenCalled();
  });

  it("never leaks the internal folder reason to the browser", async () => {
    installFakes({ folderError: new FolderUnavailableError("shared-drive") });

    const response = await GET(await signedRequest(`${BASE_URL}?folderId=${FOLDER_ID}`));

    expect(await response.text()).not.toContain("shared-drive");
  });

  it("maps an unexpected Google failure to a generic 502", async () => {
    installFakes({ listError: new GoogleApiError("Google request failed: files.list quota.") });

    const response = await GET(await signedRequest(`${BASE_URL}?folderId=${FOLDER_ID}`));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not load your dashboard." });
    expect(text).not.toContain("quota");
  });

  it("rejects a folder id that is not a usable string", async () => {
    const fakes = installFakes();

    const response = await GET(await signedRequest(`${BASE_URL}?folderId=${"x".repeat(300)}`));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Select a folder before continuing." });
    expect(fakes.validateFolder).not.toHaveBeenCalled();
  });
});
