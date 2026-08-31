import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  serializeAppConfig,
  type AppConfig,
} from "@/lib/config/schema";
import { GoogleApiError } from "@/lib/google/errors";
import type {
  AttendanceFileSummary,
  CellValue,
  CreatedDriveFile,
  DriveFileAccess,
  DriveFolder,
  DriveGateway,
  SheetSummary,
  SheetsGateway,
  ValuePatch,
} from "@/lib/google/types";
import { TIME_SLOTS } from "@/lib/attendance/slots";
import type { TimeSlot } from "@/lib/attendance/model";
import { handleAttendanceRead, handleAttendanceSave } from "./route";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const FILE_ID = "file-1";
const SHEET_A_ID = "111";
const SHEET_B_ID = "222";
const SHEET_A_TITLE = "Employee A";
const SHEET_B_TITLE = "Employee B";
const MONTH = "2026-07";
const MANAGER = "manager@blended-asia.com";
const EMPLOYEE_A = "employee.a@blended-asia.com";
const EMPLOYEE_B = "employee.b@blended-asia.com";
const DAY_4 = "2026-07-04";

function url(fileId = FILE_ID, sheetId = SHEET_A_ID): string {
  return `http://attendance.test/api/files/${fileId}/attendance/${sheetId}`;
}

function routeContext(fileId = FILE_ID, sheetId = SHEET_A_ID) {
  return { params: Promise.resolve({ fileId, sheetId }) };
}

async function signedRequest(
  email: string,
  init: RequestInit = {},
  target = url(),
): Promise<Request> {
  const encrypted = await encode({
    secret: SECRET,
    salt: COOKIE_NAME,
    token: { email, accessToken: "provider-access-token" },
  });

  const headers = new Headers(init.headers);
  headers.set("cookie", `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`);
  return new Request(target, { ...init, headers });
}

async function savePost(email: string, body: unknown, sheetId = SHEET_A_ID): Promise<Request> {
  return signedRequest(
    email,
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    url(FILE_ID, sheetId),
  );
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MONTH_DATES = Array.from(
  { length: 31 },
  (_, index) => `${MONTH}-${String(index + 1).padStart(2, "0")}`,
);

function toSerial(isoDate: string): number {
  return (Date.parse(`${isoDate}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const APP_CONFIG: AppConfig = {
  schemaVersion: 1,
  setupState: "ready",
  month: MONTH,
  ownerEmail: MANAGER,
  templateVersion: 1,
  statuses: [
    { code: "office", labelEn: "Office", sheetValue: "出社" },
    { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
  ],
  members: [
    {
      displayName: "Employee A",
      email: EMPLOYEE_A,
      sheetId: SHEET_A_ID,
      sheetTitle: SHEET_A_TITLE,
      protectionId: "911",
      permissionId: "permission-a",
      setupStatus: "ready",
    },
    {
      displayName: "Employee B",
      email: EMPLOYEE_B,
      sheetId: SHEET_B_ID,
      sheetTitle: SHEET_B_TITLE,
      protectionId: "922",
      permissionId: "permission-b",
      setupStatus: "ready",
    },
  ],
};

const SHEET_SUMMARIES: SheetSummary[] = [
  {
    sheetId: 0,
    title: CONFIG_SHEET_TITLE,
    index: 0,
    hidden: true,
    protectedRanges: [{ protectedRangeId: 1, sheetId: 0 }],
  },
  {
    sheetId: 111,
    title: SHEET_A_TITLE,
    index: 1,
    hidden: false,
    protectedRanges: [{ protectedRangeId: 911, sheetId: 111 }],
  },
  {
    sheetId: 222,
    title: SHEET_B_TITLE,
    index: 2,
    hidden: false,
    protectedRanges: [{ protectedRangeId: 922, sheetId: 222 }],
  },
];

function attendanceRow(isoDate: string, slots: Partial<Record<TimeSlot, string>> = {}): CellValue[] {
  const row: CellValue[] = new Array<CellValue>(45).fill("");
  row[0] = toSerial(isoDate);
  row[1] = "Sat";
  row[3] = "出社";
  row[4] = 9;
  row[5] = 18;
  row[6] = 1;
  row[7] = 8;
  row[8] = "Old note";
  for (const [slot, text] of Object.entries(slots)) {
    row[9 + TIME_SLOTS.indexOf(slot as TimeSlot)] = text ?? "";
  }
  return row;
}

function sheetValues(title: string): Record<string, CellValue[][]> {
  const block = MONTH_DATES.map((date) => attendanceRow(date));
  const ranges: Record<string, CellValue[][]> = {
    [`'${title}'!A4:AS34`]: block,
    [`'${title}'!A4:A34`]: block.map((row) => [row[0]]),
  };
  block.forEach((row, index) => {
    ranges[`'${title}'!A${index + 4}:AS${index + 4}`] = [row];
  });
  return ranges;
}

function allValues(config: AppConfig | null = APP_CONFIG): Record<string, CellValue[][]> {
  const serialized = config === null ? null : serializeAppConfig(config);
  return {
    ...(serialized === null
      ? {}
      : {
          [CONFIG_SETTINGS_RANGE]: serialized.settings,
          [CONFIG_STATUS_RANGE]: serialized.statuses,
          [CONFIG_MEMBER_RANGE]: serialized.members,
        }),
    ...sheetValues(SHEET_A_TITLE),
    ...sheetValues(SHEET_B_TITLE),
  };
}

interface FakeGateways {
  drive: DriveGateway;
  sheets: SheetsGateway;
  valueUpdates: { range: string; value: CellValue }[];
  tokens: string[];
}

function createGateways(options: {
  actorOwnsFile?: boolean;
  values?: Record<string, CellValue[][]>;
  sheets?: SheetSummary[];
  readError?: unknown;
  /** What Sheets reports as `spreadsheet.properties.timeZone`. */
  timeZone?: string | null;
} = {}): FakeGateways & { createGateways: (accessToken: string) => FakeGateways } {
  const valueUpdates: { range: string; value: CellValue }[] = [];
  const tokens: string[] = [];
  const values = options.values ?? allValues();

  const drive: DriveGateway = {
    async getFileAccess(fileId): Promise<DriveFileAccess> {
      return {
        id: fileId,
        name: "2026-07 勤怠管理表",
        mimeType: "application/vnd.google-apps.spreadsheet",
        trashed: false,
        ownedByMe: options.actorOwnsFile === true,
        ownerEmail: MANAGER,
        appProperties: {},
        canEdit: true,
      };
    },
    async listPeople(): Promise<never[]> {
      return [];
    },
    async validateManagerFolder(): Promise<DriveFolder> {
      throw new Error("not-used");
    },
    async listManagerFiles(): Promise<AttendanceFileSummary[]> {
      throw new Error("not-used");
    },
    async listEmployeeCandidates(): Promise<AttendanceFileSummary[]> {
      throw new Error("not-used");
    },
    async createSpreadsheetFile(): Promise<CreatedDriveFile> {
      throw new Error("not-used");
    },
    async convertXlsx(): Promise<CreatedDriveFile> {
      throw new Error("not-used");
    },
    async createWriterPermission(): Promise<string> {
      throw new Error("not-used");
    },
    async updateAppProperties(): Promise<void> {
      throw new Error("not-used");
    },
  };

  const sheets: SheetsGateway = {
    async getSpreadsheet(fileId) {
      if (options.readError) throw options.readError;
      return {
        spreadsheetId: fileId,
        timeZone: options.timeZone === undefined ? "Asia/Tokyo" : options.timeZone,
        sheets: options.sheets ?? SHEET_SUMMARIES,
      };
    },
    async batchUpdate(fileId) {
      return { spreadsheetId: fileId, replies: [] };
    },
    async getValues(_fileId, ranges) {
      return ranges.map((range) => ({ range, values: values[range] ?? [] }));
    },
    async updateValues(_fileId, patches: ValuePatch[]) {
      for (const patch of patches) {
        valueUpdates.push({ range: patch.range, value: patch.values[0][0] });
      }
    },
  };

  const gateways: FakeGateways = { drive, sheets, valueUpdates, tokens };
  return {
    ...gateways,
    createGateways(accessToken: string) {
      tokens.push(accessToken);
      return gateways;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubAuthEnv(): void {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
}

/* -------------------------------------------------------------------------- */
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

describe("GET /api/files/[fileId]/attendance/[sheetId]", () => {
  it("returns the mapped month model to the signed-in employee", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const body = (await response.json()) as {
      sheetId: number;
      sheetTitle: string;
      month: string;
      role: string;
      statuses: unknown;
      days: { date: string }[];
    };
    expect(body.sheetId).toBe(111);
    expect(body.sheetTitle).toBe(SHEET_A_TITLE);
    expect(body.month).toBe(MONTH);
    expect(body.role).toBe("employee");
    expect(body.statuses).toEqual(APP_CONFIG.statuses);
    expect(body.days).toHaveLength(31);
    expect(fakes.tokens).toEqual(["provider-access-token"]);
  });

  it("surfaces the spreadsheet's own timezone so the client never guesses Today", async () => {
    stubAuthEnv();
    const fakes = createGateways({ timeZone: "Asia/Tokyo" });

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { spreadsheetTimeZone: string | null };
    expect(body.spreadsheetTimeZone).toBe("Asia/Tokyo");
  });

  it("surfaces a null timezone rather than a fallback when the spreadsheet has none", async () => {
    stubAuthEnv();
    const fakes = createGateways({ timeZone: null });

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      spreadsheetTimeZone: string | null;
      days: unknown[];
    };
    expect(body.spreadsheetTimeZone).toBeNull();
    // The month still loads: only Today is undeterminable.
    expect(body.days).toHaveLength(31);
  });

  it("rejects an anonymous request before any Google call", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceRead(new Request(url()), routeContext(), fakes);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fakes.tokens).toEqual([]);
  });

  it("returns 403 without leaking the other employee's identity", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A, {}, url(FILE_ID, SHEET_B_ID)),
      routeContext(FILE_ID, SHEET_B_ID),
      fakes,
    );

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      code: "forbidden",
      error: "You do not have access to this attendance sheet.",
    });
    expect(text).not.toContain(EMPLOYEE_B);
    expect(text).not.toContain(SHEET_B_TITLE);
  });

  /**
   * An unconfigured file is no longer a 422: it opens on Google's own sharing.
   * A configuration that exists but is broken is still refused — see the
   * needs-repair case below.
   */
  it("opens a file that carries no configuration at all", async () => {
    stubAuthEnv();
    const fakes = createGateways({
      sheets: [
        { sheetId: 111, title: SHEET_A_TITLE, index: 0, hidden: false, protectedRanges: [] },
      ],
      values: sheetValues(SHEET_A_TITLE),
    });

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ role: "open", month: "2026-07" });
  });

  it("returns 502 for a Google transport failure", async () => {
    stubAuthEnv();
    const fakes = createGateways({ readError: new GoogleApiError("Google request failed.") });

    const response = await handleAttendanceRead(
      await signedRequest(EMPLOYEE_A),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "google-unavailable",
      error: "Google Sheets could not be reached. Try again.",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/files/[fileId]/attendance/[sheetId]", () => {
  it("saves only the dirty cell and discloses same-cell conflicts", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceSave(
      await savePost(EMPLOYEE_A, {
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Stale note", value: "Web note wins" }],
      }),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      row: number;
      workHours: number;
      written: { range: string }[];
      conflicts: { range: string; baseline: string; current: string }[];
    };
    expect(body.row).toBe(7);
    expect(body.workHours).toBe(8);
    expect(body.written).toEqual([{ range: "I7", baseline: "Stale note", value: "Web note wins" }]);
    expect(body.conflicts).toEqual([
      { range: "I7", baseline: "Stale note", current: "Old note" },
    ]);
    expect(fakes.valueUpdates).toEqual([{ range: "'Employee A'!I7", value: "Web note wins" }]);
  });

  it("returns 400 for an unparsable body without redirecting the client", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceSave(
      await savePost(EMPLOYEE_A, { patches: [] }),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.redirected).toBe(false);
    await expect(response.json()).resolves.toEqual({
      code: "invalid-request",
      error: "The attendance save request is not valid.",
    });
    expect(fakes.valueUpdates).toEqual([]);
  });

  it("returns 400 with the validation issues and never redirects away from unsaved edits", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceSave(
      await savePost(EMPLOYEE_A, {
        date: DAY_4,
        patches: [{ field: "clockOut", baseline: 18, value: 8 }],
      }),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const body = (await response.json()) as { code: string; issues: { code: string }[] };
    expect(body.code).toBe("invalid-day");
    expect(body.issues.map((issue) => issue.code)).toContain("clock-order");
    expect(fakes.valueUpdates).toEqual([]);
  });

  it("refuses a save addressed at another employee's sheet", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceSave(
      await savePost(
        EMPLOYEE_A,
        { date: DAY_4, patches: [{ field: "notes", baseline: "", value: "Not mine" }] },
        SHEET_B_ID,
      ),
      routeContext(FILE_ID, SHEET_B_ID),
      fakes,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(fakes.valueUpdates).toEqual([]);
  });

  it("returns 409 when the sheet no longer holds the requested date", async () => {
    stubAuthEnv();
    const fakes = createGateways({
      values: { ...allValues(), [`'${SHEET_A_TITLE}'!A4:A34`]: [] },
    });

    const response = await handleAttendanceSave(
      await savePost(EMPLOYEE_A, {
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "New note" }],
      }),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "sheet-structure",
      error: "This attendance sheet changed. Reload it and try again.",
    });
    expect(fakes.valueUpdates).toEqual([]);
  });

  it("rejects an anonymous save without touching Google", async () => {
    stubAuthEnv();
    const fakes = createGateways();

    const response = await handleAttendanceSave(
      new Request(url(), {
        method: "POST",
        body: JSON.stringify({ date: DAY_4, patches: [] }),
        headers: { "content-type": "application/json" },
      }),
      routeContext(),
      fakes,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(fakes.tokens).toEqual([]);
  });

  it("lets the owning manager save into a mapped member sheet", async () => {
    stubAuthEnv();
    const fakes = createGateways({ actorOwnsFile: true });

    const response = await handleAttendanceSave(
      await savePost(
        MANAGER,
        { date: DAY_4, patches: [{ field: "status", baseline: "office", value: "absent" }] },
        SHEET_B_ID,
      ),
      routeContext(FILE_ID, SHEET_B_ID),
      fakes,
    );

    expect(response.status).toBe(200);
    expect(fakes.valueUpdates).toEqual([{ range: "'Employee B'!D7", value: "欠勤" }]);
  });
});
