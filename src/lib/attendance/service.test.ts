import { describe, expect, it } from "vitest";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  serializeAppConfig,
  type AppConfig,
} from "@/lib/config/schema";
import { isAccessError } from "@/lib/access/policy";
import type {
  AttendanceFileSummary,
  CellValue,
  CreatedDriveFile,
  DriveFileAccess,
  DriveFolder,
  DriveGateway,
  RangeValues,
  SheetSummary,
  SheetsGateway,
  SpreadsheetSnapshot,
  ValuePatch,
} from "@/lib/google/types";
import { emptyDay, type TimeSlot } from "./model";
import { TIME_SLOTS } from "./slots";
import { isAttendanceError, readAttendanceMonth, saveAttendanceDay } from "./service";
import { todayInZone } from "./zone";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const FILE_ID = "file-1";
const MONTH = "2026-07";
const MANAGER = "manager@blended-asia.com";
const EMPLOYEE_A = "employee.a@blended-asia.com";
const EMPLOYEE_B = "employee.b@blended-asia.com";
const SHEET_A_ID = "111";
const SHEET_B_ID = "222";
const SHEET_A_TITLE = "Employee A";
const SHEET_B_TITLE = "Employee B";

const MONTH_DATES = Array.from(
  { length: 31 },
  (_, index) => `${MONTH}-${String(index + 1).padStart(2, "0")}`,
);

const SHEET_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

function toSerial(isoDate: string): number {
  return (Date.parse(`${isoDate}T00:00:00.000Z`) - SHEET_EPOCH_UTC_MS) / MS_PER_DAY;
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

interface RowSpec {
  status?: string;
  clockIn?: CellValue;
  clockOut?: CellValue;
  breakHours?: CellValue;
  workHours?: CellValue;
  notes?: CellValue;
  slots?: Partial<Record<TimeSlot, string>>;
  /** Overrides the generated column-A serial number. */
  date?: CellValue;
}

const COLUMN_COUNT = 45;
const SLOT_FIRST_INDEX = 9;

function attendanceRow(isoDate: string, spec: RowSpec = {}): CellValue[] {
  const row: CellValue[] = new Array<CellValue>(COLUMN_COUNT).fill("");
  row[0] = spec.date === undefined ? toSerial(isoDate) : spec.date;
  row[1] = "Sat";
  row[2] = "";
  row[3] = spec.status ?? "";
  row[4] = spec.clockIn ?? "";
  row[5] = spec.clockOut ?? "";
  row[6] = spec.breakHours ?? "";
  row[7] = spec.workHours ?? "";
  row[8] = spec.notes ?? "";

  for (const [slot, text] of Object.entries(spec.slots ?? {})) {
    row[SLOT_FIRST_INDEX + TIME_SLOTS.indexOf(slot as TimeSlot)] = text ?? "";
  }

  return row;
}

function quoted(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Every range the service can ask for on one employee sheet, for one month. */
function attendanceRanges(
  title: string,
  specs: Record<string, RowSpec> = {},
): Record<string, CellValue[][]> {
  const block = MONTH_DATES.map((date) => attendanceRow(date, specs[date] ?? {}));
  const ranges: Record<string, CellValue[][]> = {
    [`${quoted(title)}!A4:AS34`]: block,
    [`${quoted(title)}!A4:A34`]: block.map((row) => [row[0]]),
  };

  block.forEach((row, index) => {
    ranges[`${quoted(title)}!A${index + 4}:AS${index + 4}`] = [row];
  });

  return ranges;
}

function configRanges(config: AppConfig | null): Record<string, CellValue[][]> {
  if (config === null) return {};
  const serialized = serializeAppConfig(config);
  return {
    [CONFIG_SETTINGS_RANGE]: serialized.settings,
    [CONFIG_STATUS_RANGE]: serialized.statuses,
    [CONFIG_MEMBER_RANGE]: serialized.members,
  };
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface FakeSheetsGateway extends SheetsGateway {
  /** Every A1 range passed to `getValues`, flattened, in call order. */
  valueReads: string[];
  /** Every written cell, flattened across batches. */
  valueUpdates: { range: string; value: CellValue }[];
  /** The resolved `valueInputOption` recorded per written range. */
  valueUpdateOptions: { range: string; inputOption: string | undefined }[];
  updateCalls: number;
}

function createFakeSheets(options: {
  sheets?: SheetSummary[];
  values?: Record<string, CellValue[][]>;
  /** What Sheets reports as `spreadsheet.properties.timeZone`. */
  timeZone?: string | null;
} = {}): FakeSheetsGateway {
  const valueReads: string[] = [];
  const valueUpdates: { range: string; value: CellValue }[] = [];
  const valueUpdateOptions: { range: string; inputOption: string | undefined }[] = [];
  const values = options.values ?? {};
  const gateway: FakeSheetsGateway = {
    valueReads,
    valueUpdates,
    valueUpdateOptions,
    updateCalls: 0,
    async getSpreadsheet(fileId): Promise<SpreadsheetSnapshot> {
      return {
        spreadsheetId: fileId,
        timeZone: options.timeZone === undefined ? "Asia/Tokyo" : options.timeZone,
        sheets: options.sheets ?? SHEET_SUMMARIES,
      };
    },
    async batchUpdate(fileId) {
      return { spreadsheetId: fileId, replies: [] };
    },
    async getValues(_fileId, ranges): Promise<RangeValues[]> {
      valueReads.push(...ranges);
      return ranges.map((range) => ({ range, values: values[range] ?? [] }));
    },
    async updateValues(_fileId, patches: ValuePatch[]) {
      gateway.updateCalls += 1;
      for (const patch of patches) {
        valueUpdates.push({ range: patch.range, value: patch.values[0][0] });
        valueUpdateOptions.push({ range: patch.range, inputOption: patch.inputOption });
      }
    },
  };

  return gateway;
}

function createFakeDrive(access: Partial<DriveFileAccess>): DriveGateway {
  return {
    async getFileAccess(fileId): Promise<DriveFileAccess> {
      return {
        id: fileId,
        name: "2026-07 勤怠管理表",
        mimeType: "application/vnd.google-apps.spreadsheet",
        trashed: false,
        ownedByMe: false,
        ownerEmail: MANAGER,
        appProperties: {},
        canEdit: true,
        ...access,
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
}

function employeeDrive(): DriveGateway {
  return createFakeDrive({ ownedByMe: false, ownerEmail: MANAGER });
}

function managerDrive(): DriveGateway {
  return createFakeDrive({ ownedByMe: true, ownerEmail: MANAGER });
}

/** Ranges outside the hidden config sheet, i.e. real attendance values. */
function attendanceValueReads(sheets: FakeSheetsGateway): string[] {
  return sheets.valueReads.filter((range) => !range.startsWith(CONFIG_SHEET_TITLE));
}

const DAY_4 = "2026-07-04";
const ROW_4 = 7;

const DAY_4_SPEC: RowSpec = {
  status: "出社",
  clockIn: 9,
  clockOut: 18,
  breakHours: 1,
  workHours: 8,
  notes: "Old note",
  slots: { "09:00": "Spec review" },
};

function readyMonth(specs: Record<string, RowSpec> = { [DAY_4]: DAY_4_SPEC }) {
  return {
    ...configRanges(APP_CONFIG),
    ...attendanceRanges(SHEET_A_TITLE, specs),
    ...attendanceRanges(SHEET_B_TITLE, {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

describe("readAttendanceMonth", () => {
  it("returns only the mapped sheet's month model, status enum, and numeric sheet identity", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.fileId).toBe(FILE_ID);
    expect(view.sheetId).toBe(111);
    expect(view.sheetTitle).toBe(SHEET_A_TITLE);
    expect(view.month).toBe(MONTH);
    // Not the owner, and there is no mapping to narrow it further.
    expect(view.role).toBe("open");
    // From the workbook contract, not from a copy stored in the sheet.
    expect(view.statuses).toEqual(APP_CONFIG.statuses);

    expect(view.days).toHaveLength(31);
    expect(view.days.map((day) => day.date)).toEqual(MONTH_DATES);
    expect(view.days.every((day) => day.date.startsWith(`${MONTH}-`))).toBe(true);

    expect(attendanceValueReads(sheets)).toEqual([`${quoted(SHEET_A_TITLE)}!A4:AS34`]);
    expect(sheets.valueReads.some((range) => range.includes(SHEET_B_TITLE))).toBe(false);
  });

  it("converts one raw sheet row into the day model and infers the lunch break", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    const base = emptyDay(DAY_4);
    expect(view.days[3]).toEqual({
      ...base,
      statusCode: "office",
      clockIn: 9,
      clockOut: 18,
      breakHours: 1,
      workHours: 8,
      lunchBreak: true,
      notes: "Old note",
      slots: { ...base.slots, "09:00": "Spec review" },
    });
  });

  it("does not infer a lunch break when a lunch slot still holds work text", async () => {
    const sheets = createFakeSheets({
      values: readyMonth({
        [DAY_4]: { ...DAY_4_SPEC, slots: { "09:00": "Spec review", "12:00": "Working lunch" } },
      }),
    });
    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.days[3].breakHours).toBe(1);
    expect(view.days[3].lunchBreak).toBe(false);
  });

  it("lets a manager address any mapped member sheet in the file they own", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const view = await readAttendanceMonth(
      { drive: managerDrive(), sheets },
      { fileId: FILE_ID, actorEmail: MANAGER, sheetId: SHEET_B_ID },
    );

    expect(view.role).toBe("manager");
    expect(view.sheetId).toBe(222);
    expect(view.sheetTitle).toBe(SHEET_B_TITLE);
    expect(attendanceValueReads(sheets)).toEqual([`${quoted(SHEET_B_TITLE)}!A4:AS34`]);
  });

  it("refuses a manager request for the hidden configuration sheet", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await expect(
      readAttendanceMonth(
        { drive: managerDrive(), sheets },
        { fileId: FILE_ID, actorEmail: MANAGER, sheetId: "0" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(attendanceValueReads(sheets)).toEqual([]);
  });

  /**
   * Cross-tab reading is Google's decision, not this app's.
   *
   * The old check refused employee A the tab titled for employee B. It was
   * measured to protect nothing — every real workbook has `protectedRanges: []`,
   * so anyone with the link can open any tab in Google Sheets itself — while it
   * did refuse every file that carries no `__APP_CONFIG`, which is all of them.
   * See `docs/decisions/2026-08-29-app-is-a-sheets-client.md`.
   */
  it("reads another visible tab, because Google's sharing is the boundary", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_B_ID },
    );

    expect(view.sheetTitle).toBe(SHEET_B_TITLE);
    expect(view.role).toBe("open");
  });

  it("still refuses a tab the file does not have", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const error = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: "9999" },
    ).catch((thrown: unknown) => thrown);

    expect(isAccessError(error)).toBe(true);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(attendanceValueReads(sheets)).toEqual([]);
    expect(sheets.valueUpdates).toEqual([]);
  });

  /**
   * A file this app never configured is opened rather than refused: the month
   * comes from the Drive name and the status list from the workbook defaults.
   */
  it("opens a file that has never been configured", async () => {
    const sheets = createFakeSheets({
      sheets: [{ sheetId: 111, title: SHEET_A_TITLE, index: 0, hidden: false, protectedRanges: [] }],
      values: attendanceRanges(SHEET_A_TITLE),
    });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.role).toBe("open");
    expect(view.month).toBe("2026-07");
    expect(view.sheetTitle).toBe(SHEET_A_TITLE);
    expect(attendanceValueReads(sheets).length).toBeGreaterThan(0);
  });

  /*
   * `Today` is the spreadsheet's day. These prove the value the calendar needs
   * reaches the month view, and that it is never quietly replaced by UTC or by
   * the device zone — Vitest pins `TZ=America/Los_Angeles`.
   */

  it("exposes the spreadsheet's own IANA timezone on the month view", async () => {
    const sheets = createFakeSheets({ values: readyMonth(), timeZone: "Asia/Tokyo" });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.spreadsheetTimeZone).toBe("Asia/Tokyo");
    // Declared optional on the type only for older fixtures; a real read always
    // carries the key, so a consumer never has to distinguish the two absences.
    expect(Object.hasOwn(view, "spreadsheetTimeZone")).toBe(true);

    // 23:30 UTC on 1 July is already 2 July in Tokyo, and still 1 July in UTC
    // and in the test process's own Pacific zone.
    const instant = new Date("2026-07-01T23:30:00.000Z");
    expect(todayInZone(view.spreadsheetTimeZone, instant)).toBe("2026-07-02");
    expect(todayInZone("UTC", instant)).toBe("2026-07-01");
  });

  it("resolves a different Today after the file context changes to a file in another zone", async () => {
    const instant = new Date("2026-07-01T23:30:00.000Z");

    const tokyoView = await readAttendanceMonth(
      {
        drive: employeeDrive(),
        sheets: createFakeSheets({ values: readyMonth(), timeZone: "Asia/Tokyo" }),
      },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );
    const losAngelesView = await readAttendanceMonth(
      {
        drive: employeeDrive(),
        sheets: createFakeSheets({ values: readyMonth(), timeZone: "America/Los_Angeles" }),
      },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(todayInZone(tokyoView.spreadsheetTimeZone, instant)).toBe("2026-07-02");
    expect(todayInZone(losAngelesView.spreadsheetTimeZone, instant)).toBe("2026-07-01");
  });

  it("reports the timezone as null — never UTC — when the spreadsheet does not supply one", async () => {
    const sheets = createFakeSheets({ values: readyMonth(), timeZone: null });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    // Still navigable: the month is fully returned, only Today is undeterminable.
    expect(Object.hasOwn(view, "spreadsheetTimeZone")).toBe(true);
    expect(view.spreadsheetTimeZone).toBeNull();
    expect(view.days).toHaveLength(31);
    expect(todayInZone(view.spreadsheetTimeZone, new Date("2026-07-01T23:30:00.000Z"))).toBeNull();
  });

  it("reports the timezone as null when the spreadsheet supplies a non-IANA zone", async () => {
    // Sheets documents `GMT-07:00` as its custom-zone fallback; it is not IANA.
    const sheets = createFakeSheets({ values: readyMonth(), timeZone: "GMT-07:00" });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.spreadsheetTimeZone).toBeNull();
    expect(view.days).toHaveLength(31);
  });

  it("exposes the spreadsheet timezone for a file that has never been configured", async () => {
    const sheets = createFakeSheets({
      sheets: [{ sheetId: 111, title: SHEET_A_TITLE, index: 0, hidden: false, protectedRanges: [] }],
      values: attendanceRanges(SHEET_A_TITLE),
      timeZone: "Europe/Berlin",
    });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.role).toBe("open");
    expect(view.spreadsheetTimeZone).toBe("Europe/Berlin");
  });

  it("does not care that the configuration is unreadable — it never reads it", async () => {
    const sheets = createFakeSheets({
      values: {
        ...configRanges(APP_CONFIG),
        // A schema version this build cannot parse. It used to abort the read
        // with `needs-repair`; the month no longer comes from here.
        [CONFIG_SETTINGS_RANGE]: [["schemaVersion", "9"]],
        ...attendanceRanges(SHEET_A_TITLE),
      },
    });

    const view = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
    );

    expect(view.month).toBe(MONTH);
    // Nothing in the configuration range was requested at all.
    expect(sheets.valueReads.some((range) => range.includes(CONFIG_SHEET_TITLE))).toBe(false);
  });

  it("refuses the hidden configuration tab as a place to record hours", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const error = await readAttendanceMonth(
      { drive: employeeDrive(), sheets },
      { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: "0" },
    ).catch((thrown: unknown) => thrown);

    expect(isAccessError(error)).toBe(true);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(sheets.valueUpdates).toEqual([]);
  });

  it("reports a changed sheet structure when column A no longer matches the configured month", async () => {
    const sheets = createFakeSheets({
      values: readyMonth({ [DAY_4]: { ...DAY_4_SPEC, date: toSerial("2026-08-04") } }),
    });

    await expect(
      readAttendanceMonth(
        { drive: employeeDrive(), sheets },
        { fileId: FILE_ID, actorEmail: EMPLOYEE_A, sheetId: SHEET_A_ID },
      ),
    ).rejects.toMatchObject({ code: "sheet-structure" });
  });
});

/* -------------------------------------------------------------------------- */
/* Save                                                                        */
/* -------------------------------------------------------------------------- */

describe("saveAttendanceDay", () => {
  it("writes exactly one cell when only the note changed", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "New note" }],
      },
    );

    expect(sheets.valueUpdates).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!I${ROW_4}`, value: "New note" },
    ]);
    expect(result.written).toEqual([{ range: `I${ROW_4}`, baseline: "Old note", value: "New note" }]);
    expect(result.conflicts).toEqual([]);
    expect(result.row).toBe(ROW_4);
  });

  it("writes exactly the mapped work-slot column for work text at 09:00", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [
          { field: "slot", slot: "09:00", baseline: "Spec review", value: "Spec review v2" },
        ],
      },
    );

    expect(sheets.valueUpdates).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!P${ROW_4}`, value: "Spec review v2" },
    ]);
    expect(result.written.map((patch) => patch.range)).toEqual([`P${ROW_4}`]);
  });

  it("writes only the dirty summary cells and never the work-hours formula cell", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });
    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [
          { field: "clockIn", baseline: 9, value: 8.5 },
          { field: "breakHours", baseline: 1, value: 0.5 },
          { field: "notes", baseline: "Old note", value: "New note" },
        ],
      },
    );

    const written = sheets.valueUpdates.map((update) => update.range);
    expect(written).toEqual([
      `${quoted(SHEET_A_TITLE)}!E${ROW_4}`,
      `${quoted(SHEET_A_TITLE)}!G${ROW_4}`,
      `${quoted(SHEET_A_TITLE)}!I${ROW_4}`,
    ]);
    expect(written.some((range) => range.endsWith(`!H${ROW_4}`))).toBe(false);
    expect(result.workHours).toBe(9);
  });

  it("discloses a same-cell conflict while the web value still wins", async () => {
    const sheets = createFakeSheets({
      values: readyMonth({ [DAY_4]: { ...DAY_4_SPEC, notes: "Changed in Sheet" } }),
    });

    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "Web note wins" }],
      },
    );

    expect(result.conflicts).toEqual([
      { range: "I7", baseline: "Old note", current: "Changed in Sheet" },
    ]);
    expect(sheets.valueUpdates).toEqual([
      { range: "'Employee A'!I7", value: "Web note wins" },
    ]);
  });

  it("does not report a conflict or widen the write when a different cell changed", async () => {
    const sheets = createFakeSheets({
      values: readyMonth({ [DAY_4]: { ...DAY_4_SPEC, clockOut: 19 } }),
    });

    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "Web note wins" }],
      },
    );

    expect(result.conflicts).toEqual([]);
    expect(sheets.valueUpdates).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!I${ROW_4}`, value: "Web note wins" },
    ]);
  });

  it("stores a note that starts with an equals sign literally instead of as a formula", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [
          { field: "notes", baseline: "Old note", value: "=1+1" },
          { field: "slot", slot: "09:00", baseline: "Spec review", value: "2026-07" },
        ],
      },
    );

    expect(sheets.valueUpdates).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!I${ROW_4}`, value: "=1+1" },
      { range: `${quoted(SHEET_A_TITLE)}!P${ROW_4}`, value: "2026-07" },
    ]);
    expect(sheets.valueUpdateOptions).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!I${ROW_4}`, inputOption: "RAW" },
      { range: `${quoted(SHEET_A_TITLE)}!P${ROW_4}`, inputOption: "RAW" },
    ]);
  });

  it("maps a status code to its sheet value and never writes arbitrary status text", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "status", baseline: "office", value: "absent" }],
      },
    );

    expect(sheets.valueUpdates).toEqual([
      { range: `${quoted(SHEET_A_TITLE)}!D${ROW_4}`, value: "欠勤" },
    ]);

    const rejected = createFakeSheets({ values: readyMonth() });
    await expect(
      saveAttendanceDay(
        { drive: employeeDrive(), sheets: rejected },
        {
          fileId: FILE_ID,
          actorEmail: EMPLOYEE_A,
          sheetId: SHEET_A_ID,
          date: DAY_4,
          patches: [{ field: "status", baseline: "office", value: "休職" }],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(rejected.valueUpdates).toEqual([]);
  });

  it("rejects a field key that is not an editable attendance cell", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const error = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        // Column H holds the `=F-G-E` formula and is never client-addressable.
        patches: [{ field: "workHours" as never, baseline: 8, value: 99 }],
      },
    ).catch((thrown: unknown) => thrown);

    expect(isAttendanceError(error)).toBe(true);
    expect(error).toMatchObject({ code: "invalid-request" });
    expect(sheets.valueUpdates).toEqual([]);
  });

  it("rejects a save whose reconstructed day breaks the clock and break rules", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const error = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "clockOut", baseline: 18, value: 8 }],
      },
    ).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "invalid-day" });
    expect((error as { issues: { code: string }[] }).issues.map((issue) => issue.code)).toContain(
      "clock-order",
    );
    expect(sheets.valueUpdates).toEqual([]);
  });

  it("rejects a break longer than the clocked duration", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await expect(
      saveAttendanceDay(
        { drive: employeeDrive(), sheets },
        {
          fileId: FILE_ID,
          actorEmail: EMPLOYEE_A,
          sheetId: SHEET_A_ID,
          date: DAY_4,
          patches: [{ field: "breakHours", baseline: 1, value: 20 }],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-day" });
    expect(sheets.valueUpdates).toEqual([]);
  });

  /**
   * Writing another visible tab is Google's decision. Every member already has
   * edit access to the whole file, so this app refusing it protected nothing —
   * see the read-side counterpart above.
   */
  it("saves into another visible tab, and writes only that tab's range", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_B_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "", value: "Covering a shift" }],
      },
    );

    expect(result.written).toHaveLength(1);
    expect(sheets.valueUpdates.every((update) => update.range.includes(SHEET_B_TITLE))).toBe(true);
  });

  it("refuses a save into the hidden configuration tab", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await expect(
      saveAttendanceDay(
        { drive: employeeDrive(), sheets },
        {
          fileId: FILE_ID,
          actorEmail: EMPLOYEE_A,
          sheetId: "0",
          date: DAY_4,
          patches: [{ field: "notes", baseline: "", value: "Not a timesheet" }],
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(sheets.valueUpdates).toEqual([]);
  });

  it("rejects a date outside the configured month before touching the sheet", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await expect(
      saveAttendanceDay(
        { drive: employeeDrive(), sheets },
        {
          fileId: FILE_ID,
          actorEmail: EMPLOYEE_A,
          sheetId: SHEET_A_ID,
          date: "2026-08-04",
          patches: [{ field: "notes", baseline: "", value: "Wrong month" }],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });

    expect(attendanceValueReads(sheets)).toEqual([]);
  });

  it("reports a changed structure when column A no longer holds the requested date", async () => {
    const sheets = createFakeSheets({
      values: {
        ...configRanges(APP_CONFIG),
        ...attendanceRanges(SHEET_A_TITLE),
        [`${quoted(SHEET_A_TITLE)}!A4:A34`]: [],
      },
    });

    await expect(
      saveAttendanceDay(
        { drive: employeeDrive(), sheets },
        {
          fileId: FILE_ID,
          actorEmail: EMPLOYEE_A,
          sheetId: SHEET_A_ID,
          date: DAY_4,
          patches: [{ field: "notes", baseline: "", value: "Missing row" }],
        },
      ),
    ).rejects.toMatchObject({ code: "sheet-structure" });

    expect(sheets.valueUpdates).toEqual([]);
  });

  it("resolves the row from column A immediately before the write", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "New note" }],
      },
    );

    expect(attendanceValueReads(sheets)).toEqual([
      `${quoted(SHEET_A_TITLE)}!A4:A34`,
      `${quoted(SHEET_A_TITLE)}!A${ROW_4}:AS${ROW_4}`,
    ]);
  });

  it("performs no Sheets write when nothing is actually dirty", async () => {
    const sheets = createFakeSheets({ values: readyMonth() });

    const result = await saveAttendanceDay(
      { drive: employeeDrive(), sheets },
      {
        fileId: FILE_ID,
        actorEmail: EMPLOYEE_A,
        sheetId: SHEET_A_ID,
        date: DAY_4,
        patches: [{ field: "notes", baseline: "Old note", value: "Old note" }],
      },
    );

    expect(result.written).toEqual([]);
    expect(sheets.valueUpdates).toEqual([]);
  });
});
