/**
 * Deterministic in-memory Drive/Sheets substitute for browser proof.
 *
 * This module is only ever reachable through `resolveTestMode`, which throws
 * rather than returning `true` when `E2E_TEST_MODE` is present in production.
 * Nothing here changes a product service, a Route Handler, or an authorization
 * rule: it implements exactly the committed `DriveGateway` and `SheetsGateway`
 * interfaces and models Google state instead of replaying canned responses, so
 * the real config repository, discovery, access policy, setup, import, and
 * attendance services run against it unmodified.
 *
 * State lives on one stable `globalThis` key so it survives Next's dev-server
 * module reloading, and identity travels in the access token the deterministic
 * session mints (`e2e:<email>`), because `createGoogleGateways` receives nothing
 * else about the caller.
 */

import { STATUS_OPTIONS } from "@/lib/attendance/model";
import { buildAppProperties } from "@/lib/config/repository";
import {
  normalizeEmail,
  serializeAppConfig,
  type AppConfig,
  type ConfigMember,
  type ConfigStatus,
} from "@/lib/config/schema";
import { FileUnavailableError, FolderUnavailableError } from "@/lib/google/errors";
import {
  SPREADSHEET_MIME_TYPE,
  type AttendanceFileSummary,
  type BatchUpdateResult,
  type CellValue,
  type ConvertXlsxInput,
  type CreateDriveSpreadsheetInput,
  type CreatedDriveFile,
  type DriveFileAccess,
  type DriveFolder,
  type DriveGateway,
  type RangeValues,
  type SheetBatchReply,
  type SheetRequest,
  type SheetSummary,
  type SheetsGateway,
  type SpreadsheetSnapshot,
  type ValuePatch,
} from "@/lib/google/types";
import { DATA_START_ROW } from "@/lib/workbook/contract";

/* -------------------------------------------------------------------------- */
/* Deterministic identity                                                      */
/* -------------------------------------------------------------------------- */

/** Marks an access token minted by the deterministic non-production session. */
export const TEST_ACCESS_TOKEN_PREFIX = "e2e:";

export function toTestAccessToken(email: string): string {
  return `${TEST_ACCESS_TOKEN_PREFIX}${normalizeEmail(email)}`;
}

export function readTestActorEmail(accessToken: string): string {
  return accessToken.startsWith(TEST_ACCESS_TOKEN_PREFIX)
    ? normalizeEmail(accessToken.slice(TEST_ACCESS_TOKEN_PREFIX.length))
    : "";
}

/* -------------------------------------------------------------------------- */
/* Fixture identifiers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The whole seeded world, named once so the browser tests assert against the
 * same identifiers the seed writes.
 */
export const E2E_FIXTURE = {
  managerEmail: "manager@blended-asia.com",
  employeeEmail: "employee@blended-asia.com",
  teammateEmail: "teammate@blended-asia.com",
  outsideOwnerEmail: "owner@example.org",
  otherManagerEmail: "lead@blended-asia.com",

  activeFolder: { id: "folder-active", name: "July attendance" },
  archiveFolder: { id: "folder-archive", name: "Archive 2026" },
  nestedFolder: { id: "folder-nested", name: "Nested folder" },
  /** Never present in the store: proves the remembered-folder failure state. */
  missingFolderId: "folder-deleted",

  readyFile: { id: "file-ready", name: "202607勤怠管理表", month: "2026-07" },
  legacyFile: { id: "file-legacy", name: "202608勤怠管理表", month: "2026-08" },
  unmarkedFile: { id: "file-unmarked", name: "Team notes" },
  nestedFile: { id: "file-nested", name: "202607勤怠管理表 (nested)" },
  archivedFile: { id: "file-archived", name: "202605勤怠管理表", month: "2026-05" },
  outsideDomainFile: { id: "file-outside-domain", name: "202607勤怠管理表" },
  unmappedFile: { id: "file-unmapped", name: "202607勤怠管理表" },

  employeeSheetTitle: "Employee A",
  teammateSheetTitle: "Employee B",
  employeeSheetId: "101",
  teammateSheetId: "102",
} as const;

/* -------------------------------------------------------------------------- */
/* State shapes                                                                */
/* -------------------------------------------------------------------------- */

interface FakeProtectedRange {
  protectedRangeId: number;
  sheetId: number;
  editors: string[];
}

interface FakeSheet {
  sheetId: number;
  title: string;
  hidden: boolean;
  protectedRanges: FakeProtectedRange[];
  /** `row:column`, both 1-based, to the stored value. */
  cells: Map<string, CellValue>;
  maxRow: number;
}

interface FakeFolder {
  id: string;
  name: string;
  ownerEmail: string;
  trashed: boolean;
  canAddChildren: boolean;
  /** Any value makes this a Shared Drive folder, which is refused. */
  driveId: string | null;
}

interface FakeFile {
  id: string;
  name: string;
  ownerEmail: string;
  folderId: string;
  trashed: boolean;
  mimeType: string;
  appProperties: Record<string, string>;
  /** Normalized emails Drive shared the file with, excluding the owner. */
  sharedWith: Set<string>;
  sheets: FakeSheet[];
}

interface FakeFaults {
  /** Consumed one per `updateValues`, to prove the editor's retry state. */
  attendanceSaveFailures: number;
  /** Emails whose next Drive invitation fails. */
  inviteFailures: Set<string>;
}

export interface FakeGoogleStore {
  folders: Map<string, FakeFolder>;
  files: Map<string, FakeFile>;
  faults: FakeFaults;
  nextSheetId: number;
  nextProtectionId: number;
  nextPermissionId: number;
  nextFileId: number;
}

/** Created sheets and protections start far above every seeded identifier. */
const FIRST_CREATED_SHEET_ID = 9000;
const FIRST_CREATED_PROTECTION_ID = 8000;

const STORE_KEY = Symbol.for("google-sheets-attendance.e2e.store");

type StoreCarrier = typeof globalThis & { [STORE_KEY]?: FakeGoogleStore };

/* -------------------------------------------------------------------------- */
/* A1 range arithmetic                                                         */
/* -------------------------------------------------------------------------- */

interface ParsedRange {
  title: string;
  startRow: number;
  startColumn: number;
  /** `null` for an open-ended range such as `__APP_CONFIG!H1:N`. */
  endRow: number | null;
  endColumn: number;
}

const RANGE_PATTERN = /^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/;

function columnIndex(letters: string): number {
  return [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

function parseRange(range: string): ParsedRange {
  const match = RANGE_PATTERN.exec(range);
  if (!match) throw new Error(`The E2E sheet store cannot address "${range}".`);

  const startColumn = columnIndex(match[3]);
  const hasEndColumn = match[5] !== undefined;

  return {
    title: (match[1] ?? match[2]).replace(/''/g, "'"),
    startRow: Number(match[4]),
    startColumn,
    endRow: match[6] !== undefined ? Number(match[6]) : hasEndColumn ? null : Number(match[4]),
    endColumn: hasEndColumn ? columnIndex(match[5]) : startColumn,
  };
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function writeCell(sheet: FakeSheet, row: number, column: number, value: CellValue): void {
  sheet.cells.set(cellKey(row, column), value);
  sheet.maxRow = Math.max(sheet.maxRow, row);
}

/* -------------------------------------------------------------------------- */
/* Seed                                                                        */
/* -------------------------------------------------------------------------- */

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const SHEET_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

const SEED_STATUSES: ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

function makeSheet(sheetId: number, title: string, hidden = false): FakeSheet {
  return { sheetId, title, hidden, protectedRanges: [], cells: new Map(), maxRow: 0 };
}

function protect(sheet: FakeSheet, protectedRangeId: number, editors: string[]): void {
  sheet.protectedRanges.push({ protectedRangeId, sheetId: sheet.sheetId, editors });
}

/** Writes the generated columns A, B, and C for every day of a month. */
function writeMonthGrid(sheet: FakeSheet, month: string): void {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  let businessDay = 0;

  for (let day = 1; day <= days; day += 1) {
    const date = new Date(Date.UTC(year, monthNumber - 1, day));
    const weekday = date.getUTCDay();
    const isBusinessDay = weekday !== 0 && weekday !== 6;
    const row = DATA_START_ROW + day - 1;

    writeCell(sheet, row, 1, (date.getTime() - SHEET_EPOCH_UTC_MS) / MS_PER_DAY);
    writeCell(sheet, row, 2, WEEKDAY_LABELS[weekday]);
    writeCell(sheet, row, 3, isBusinessDay ? (businessDay += 1) : "");
  }
}

/** Writes a serialized `__APP_CONFIG` at its reserved A/D/H coordinates. */
function writeConfigSheet(sheet: FakeSheet, config: AppConfig): void {
  const serialized = serializeAppConfig(config);
  const blocks = [
    { rows: serialized.settings, startColumn: columnIndex("A") },
    { rows: serialized.statuses, startColumn: columnIndex("D") },
    { rows: serialized.members, startColumn: columnIndex("H") },
  ];

  for (const block of blocks) {
    block.rows.forEach((row, rowOffset) => {
      row.forEach((value, columnOffset) => {
        writeCell(sheet, rowOffset + 1, block.startColumn + columnOffset, value);
      });
    });
  }
}

function seedMember(
  displayName: string,
  email: string,
  sheetId: number,
  protectionId: number,
): ConfigMember {
  return {
    displayName,
    email,
    sheetId: String(sheetId),
    sheetTitle: displayName,
    protectionId: String(protectionId),
    permissionId: `permission-${sheetId}`,
    setupStatus: "ready",
  };
}

interface SeedFileInput {
  id: string;
  name: string;
  ownerEmail: string;
  folderId: string;
  month?: string;
  /** Sheet ID of the hidden `__APP_CONFIG` tab; omit for an unconfigured file. */
  configSheetId?: number;
  configProtectionId?: number;
  members?: ConfigMember[];
  employeeSheets: Array<{ sheetId: number; title: string; protectionId?: number }>;
  sharedWith?: readonly string[];
}

function seedFile(input: SeedFileInput): FakeFile {
  const sheets: FakeSheet[] = [];
  const month = input.month ?? "2026-07";

  if (input.configSheetId !== undefined) {
    const configSheet = makeSheet(input.configSheetId, "__APP_CONFIG", true);
    writeConfigSheet(configSheet, {
      schemaVersion: 1,
      setupState: "ready",
      month,
      ownerEmail: input.ownerEmail,
      templateVersion: 1,
      statuses: SEED_STATUSES,
      members: input.members ?? [],
    });
    if (input.configProtectionId !== undefined) {
      protect(configSheet, input.configProtectionId, [input.ownerEmail]);
    }
    sheets.push(configSheet);
  }

  for (const employee of input.employeeSheets) {
    const sheet = makeSheet(employee.sheetId, employee.title);
    writeMonthGrid(sheet, month);

    const member = (input.members ?? []).find(
      (candidate) => candidate.sheetId === String(employee.sheetId),
    );
    if (employee.protectionId !== undefined) {
      protect(sheet, employee.protectionId, [input.ownerEmail, member?.email ?? input.ownerEmail]);
    }

    sheets.push(sheet);
  }

  return {
    id: input.id,
    name: input.name,
    ownerEmail: input.ownerEmail,
    folderId: input.folderId,
    trashed: false,
    mimeType: SPREADSHEET_MIME_TYPE,
    appProperties:
      input.configSheetId === undefined ? {} : buildAppProperties(month, "ready"),
    sharedWith: new Set((input.sharedWith ?? []).map((email) => normalizeEmail(email))),
    sheets,
  };
}

function ownedFolder(folder: { id: string; name: string }): FakeFolder {
  return {
    ...folder,
    ownerEmail: E2E_FIXTURE.managerEmail,
    trashed: false,
    canAddChildren: true,
    driveId: null,
  };
}

/**
 * Builds the whole deterministic world.
 *
 * The negative cases are as important as the positive ones: a nested file, an
 * unmarked file, an out-of-domain owner, and a shared file with no mapping all
 * exist so the browser tests can prove they are *not* listed.
 */
function buildSeededStore(): FakeGoogleStore {
  const {
    managerEmail,
    employeeEmail,
    teammateEmail,
    outsideOwnerEmail,
    otherManagerEmail,
    activeFolder,
    archiveFolder,
    nestedFolder,
    readyFile,
    legacyFile,
    unmarkedFile,
    nestedFile,
    archivedFile,
    outsideDomainFile,
    unmappedFile,
    employeeSheetTitle,
    teammateSheetTitle,
  } = E2E_FIXTURE;

  const store: FakeGoogleStore = {
    folders: new Map(),
    files: new Map(),
    faults: { attendanceSaveFailures: 0, inviteFailures: new Set() },
    nextSheetId: FIRST_CREATED_SHEET_ID,
    nextProtectionId: FIRST_CREATED_PROTECTION_ID,
    nextPermissionId: 1,
    nextFileId: 1,
  };

  for (const folder of [activeFolder, archiveFolder, nestedFolder]) {
    store.folders.set(folder.id, ownedFolder(folder));
  }

  const files: FakeFile[] = [
    seedFile({
      ...readyFile,
      ownerEmail: managerEmail,
      folderId: activeFolder.id,
      configSheetId: 100,
      configProtectionId: 200,
      members: [
        seedMember(employeeSheetTitle, employeeEmail, 101, 201),
        seedMember(teammateSheetTitle, teammateEmail, 102, 202),
      ],
      employeeSheets: [
        { sheetId: 101, title: employeeSheetTitle, protectionId: 201 },
        { sheetId: 102, title: teammateSheetTitle, protectionId: 202 },
      ],
      sharedWith: [employeeEmail, teammateEmail],
    }),

    // Created outside this application: matching name, no configuration sheet.
    seedFile({
      ...legacyFile,
      ownerEmail: managerEmail,
      folderId: activeFolder.id,
      employeeSheets: [
        { sheetId: 110, title: employeeSheetTitle },
        { sheetId: 111, title: teammateSheetTitle },
      ],
    }),

    // Excluded by the case-sensitive filename marker.
    seedFile({
      ...unmarkedFile,
      ownerEmail: managerEmail,
      folderId: activeFolder.id,
      employeeSheets: [{ sheetId: 112, title: "Notes" }],
    }),

    // Excluded because manager discovery never descends into subfolders.
    seedFile({
      ...nestedFile,
      ownerEmail: managerEmail,
      folderId: nestedFolder.id,
      employeeSheets: [{ sheetId: 113, title: employeeSheetTitle }],
    }),

    seedFile({
      ...archivedFile,
      ownerEmail: managerEmail,
      folderId: archiveFolder.id,
      configSheetId: 120,
      configProtectionId: 220,
      members: [seedMember(teammateSheetTitle, teammateEmail, 121, 221)],
      employeeSheets: [{ sheetId: 121, title: teammateSheetTitle, protectionId: 221 }],
      sharedWith: [teammateEmail],
    }),

    // Shared and mapped, but the owner is outside the Workspace domain.
    seedFile({
      ...outsideDomainFile,
      ownerEmail: outsideOwnerEmail,
      folderId: "folder-external",
      month: "2026-07",
      configSheetId: 130,
      configProtectionId: 230,
      members: [seedMember(employeeSheetTitle, employeeEmail, 131, 231)],
      employeeSheets: [{ sheetId: 131, title: employeeSheetTitle, protectionId: 231 }],
      sharedWith: [employeeEmail],
    }),

    // Shared by an in-domain owner, but this employee has no mapping in it.
    seedFile({
      ...unmappedFile,
      ownerEmail: otherManagerEmail,
      folderId: "folder-other-manager",
      month: "2026-07",
      configSheetId: 140,
      configProtectionId: 240,
      members: [seedMember(teammateSheetTitle, teammateEmail, 141, 241)],
      employeeSheets: [{ sheetId: 141, title: teammateSheetTitle, protectionId: 241 }],
      sharedWith: [employeeEmail, teammateEmail],
    }),
  ];

  for (const file of files) store.files.set(file.id, file);

  return store;
}

/* -------------------------------------------------------------------------- */
/* Store lifecycle                                                             */
/* -------------------------------------------------------------------------- */

export function getFakeGoogleStore(): FakeGoogleStore {
  const carrier = globalThis as StoreCarrier;
  carrier[STORE_KEY] ??= buildSeededStore();
  return carrier[STORE_KEY];
}

export interface ResetOptions {
  /** Attendance saves that must fail before one succeeds. */
  attendanceSaveFailures?: number;
  /** Emails whose Drive invitation fails once. */
  inviteFailures?: readonly string[];
}

/** Replaces the entire store with the deterministic fixture. */
export function resetFakeGoogleStore(options: ResetOptions = {}): typeof E2E_FIXTURE {
  const store = buildSeededStore();

  store.faults.attendanceSaveFailures = Math.max(0, options.attendanceSaveFailures ?? 0);
  store.faults.inviteFailures = new Set(
    (options.inviteFailures ?? []).map((email) => normalizeEmail(email)),
  );

  (globalThis as StoreCarrier)[STORE_KEY] = store;
  return E2E_FIXTURE;
}

/* -------------------------------------------------------------------------- */
/* batchUpdate request handling                                                */
/* -------------------------------------------------------------------------- */

interface GridRangeResource {
  sheetId?: number;
  startRowIndex?: number;
  startColumnIndex?: number;
}

interface CellDataResource {
  userEnteredValue?: {
    stringValue?: string;
    numberValue?: number;
    boolValue?: boolean;
    formulaValue?: string;
  };
}

function toCellValue(cell: CellDataResource | undefined): CellValue {
  const value = cell?.userEnteredValue;
  if (value === undefined) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.formulaValue !== undefined) return value.formulaValue;
  return "";
}

function read<T>(request: SheetRequest, key: string): T | undefined {
  return request[key] as T | undefined;
}

function findSheetById(file: FakeFile, sheetId: number | undefined): FakeSheet {
  const sheet = file.sheets.find((candidate) => candidate.sheetId === sheetId);
  if (!sheet) throw new Error(`The E2E store has no sheet ${String(sheetId)} in "${file.id}".`);
  return sheet;
}

function applyAddSheet(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  const properties =
    read<{ properties?: { title?: string; hidden?: boolean } }>(request, "addSheet")?.properties ??
    {};
  const title = properties.title ?? `Sheet${file.sheets.length + 1}`;

  if (file.sheets.some((sheet) => sheet.title === title)) {
    throw new Error(`A sheet named "${title}" already exists.`);
  }

  const sheet = makeSheet(store.nextSheetId++, title, properties.hidden === true);
  file.sheets.push(sheet);

  return { addSheet: { sheetId: sheet.sheetId, title } };
}

function applyDeleteSheet(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const sheetId = read<{ sheetId?: number }>(request, "deleteSheet")?.sheetId;
  const index = file.sheets.findIndex((sheet) => sheet.sheetId === sheetId);
  if (index === -1) throw new Error(`The E2E store has no sheet ${String(sheetId)} to delete.`);

  file.sheets.splice(index, 1);
  return {};
}

function applyAddProtectedRange(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  const protectedRange =
    read<{ protectedRange?: { range?: { sheetId?: number }; editors?: { users?: string[] } } }>(
      request,
      "addProtectedRange",
    )?.protectedRange ?? {};

  const sheet = findSheetById(file, protectedRange.range?.sheetId);
  const protectedRangeId = store.nextProtectionId++;
  protect(sheet, protectedRangeId, protectedRange.editors?.users ?? []);

  return { addProtectedRange: { protectedRangeId } };
}

function applyUpdateSheetProperties(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const properties =
    read<{ properties?: { sheetId?: number; hidden?: boolean } }>(request, "updateSheetProperties")
      ?.properties ?? {};

  const sheet = findSheetById(file, properties.sheetId);
  if (properties.hidden !== undefined) sheet.hidden = properties.hidden;

  return {};
}

/** Real cell writes: the create flow's calendar, headers, and formulas land here. */
function applyUpdateCells(file: FakeFile, request: SheetRequest): SheetBatchReply {
  const payload = read<{ range?: GridRangeResource; rows?: { values?: CellDataResource[] }[] }>(
    request,
    "updateCells",
  );

  const range = payload?.range ?? {};
  const sheet = findSheetById(file, range.sheetId);
  const startRow = (range.startRowIndex ?? 0) + 1;
  const startColumn = (range.startColumnIndex ?? 0) + 1;

  (payload?.rows ?? []).forEach((row, rowOffset) => {
    (row.values ?? []).forEach((cell, columnOffset) => {
      writeCell(sheet, startRow + rowOffset, startColumn + columnOffset, toCellValue(cell));
    });
  });

  return {};
}

function applyRequest(
  store: FakeGoogleStore,
  file: FakeFile,
  request: SheetRequest,
): SheetBatchReply {
  if (request.addSheet !== undefined) return applyAddSheet(store, file, request);
  if (request.deleteSheet !== undefined) return applyDeleteSheet(file, request);
  if (request.addProtectedRange !== undefined) return applyAddProtectedRange(store, file, request);
  if (request.updateSheetProperties !== undefined) return applyUpdateSheetProperties(file, request);
  if (request.updateCells !== undefined) return applyUpdateCells(file, request);

  // mergeCells / repeatCell / setDataValidation are presentation only: they
  // carry no reply and no state any product rule reads back.
  return {};
}

/* -------------------------------------------------------------------------- */
/* Gateways                                                                    */
/* -------------------------------------------------------------------------- */

function isAddressable(file: FakeFile, actorEmail: string): boolean {
  return file.ownerEmail === actorEmail || file.sharedWith.has(actorEmail);
}

function toSheetSummary(sheet: FakeSheet, index: number): SheetSummary {
  return {
    sheetId: sheet.sheetId,
    title: sheet.title,
    index,
    hidden: sheet.hidden,
    protectedRanges: sheet.protectedRanges.map((range) => ({
      protectedRangeId: range.protectedRangeId,
      sheetId: range.sheetId,
    })),
  };
}

function toFileSummary(file: FakeFile, actorEmail: string): AttendanceFileSummary {
  return {
    id: file.id,
    name: file.name,
    ownedByMe: file.ownerEmail === actorEmail,
    sharedWithMe: file.ownerEmail !== actorEmail && file.sharedWith.has(actorEmail),
    ownerEmail: file.ownerEmail,
    appProperties: { ...file.appProperties },
    modifiedTime: "2026-07-31T09:00:00.000Z",
  };
}

function createFakeDriveGateway(store: FakeGoogleStore, actorEmail: string): DriveGateway {
  function requireFile(fileId: string): FakeFile {
    const file = store.files.get(fileId);
    if (!file || !isAddressable(file, actorEmail)) throw new FileUnavailableError("not-found");
    return file;
  }

  return {
    async validateManagerFolder(folderId) {
      const folder = store.folders.get(folderId);

      // Mirrors the real gateway's refusal order, so the dashboard reaches the
      // same `Folder unavailable` state for the same reasons.
      if (!folder) throw new FolderUnavailableError("not-found");
      if (folder.trashed) throw new FolderUnavailableError("trashed");
      if (folder.ownerEmail !== actorEmail) throw new FolderUnavailableError("not-owned");
      if (folder.driveId) throw new FolderUnavailableError("shared-drive");
      if (!folder.canAddChildren) throw new FolderUnavailableError("not-writable");

      return { id: folder.id, name: folder.name } satisfies DriveFolder;
    },

    async listManagerFiles(folderId) {
      return [...store.files.values()]
        .filter(
          (file) =>
            file.folderId === folderId &&
            !file.trashed &&
            file.mimeType === SPREADSHEET_MIME_TYPE &&
            file.ownerEmail === actorEmail,
        )
        .map((file) => toFileSummary(file, actorEmail));
    },

    async listEmployeeCandidates() {
      return [...store.files.values()]
        .filter(
          (file) =>
            !file.trashed &&
            file.mimeType === SPREADSHEET_MIME_TYPE &&
            file.ownerEmail !== actorEmail &&
            file.sharedWith.has(actorEmail),
        )
        .map((file) => toFileSummary(file, actorEmail));
    },

    async getFileAccess(fileId): Promise<DriveFileAccess> {
      const file = requireFile(fileId);

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        trashed: file.trashed,
        ownedByMe: file.ownerEmail === actorEmail,
        ownerEmail: file.ownerEmail,
        appProperties: { ...file.appProperties },
        canEdit: true,
      };
    },

    async createSpreadsheetFile(input: CreateDriveSpreadsheetInput): Promise<CreatedDriveFile> {
      const id = `created-${store.nextFileId++}`;

      store.files.set(id, {
        id,
        name: input.name,
        ownerEmail: actorEmail,
        folderId: input.folderId,
        trashed: false,
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { ...(input.appProperties ?? {}) },
        sharedWith: new Set(),
        sheets: [makeSheet(store.nextSheetId++, "Sheet1")],
      });

      return { id, name: input.name };
    },

    /**
     * Models Drive's XLSX conversion by reading the very bytes the wizard
     * uploaded, so the converted file really has the workbook's own tabs and
     * the import service resolves them by title exactly as it would in Google.
     */
    async convertXlsx(input: ConvertXlsxInput): Promise<CreatedDriveFile> {
      // Imported lazily so the workbook parser (and ExcelJS behind it) never
      // enters the static module graph of the production gateway factory.
      const { inspectXlsx } = await import("@/lib/workbook/xlsx-inspector");
      const inspection = await inspectXlsx(input.content);
      const id = `imported-${store.nextFileId++}`;

      store.files.set(id, {
        id,
        name: input.name,
        ownerEmail: actorEmail,
        folderId: input.folderId,
        trashed: false,
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { ...(input.appProperties ?? {}) },
        sharedWith: new Set(),
        sheets: inspection.sheets.map((sheet) => {
          const tab = makeSheet(store.nextSheetId++, sheet.title);
          writeMonthGrid(tab, sheet.month);
          return tab;
        }),
      });

      return { id, name: input.name };
    },

    async createWriterPermission(fileId, email) {
      const file = requireFile(fileId);
      const normalized = normalizeEmail(email);

      if (store.faults.inviteFailures.has(normalized)) {
        store.faults.inviteFailures.delete(normalized);
        throw new Error("Drive refused the invitation.");
      }

      file.sharedWith.add(normalized);
      return `permission-${store.nextPermissionId++}`;
    },

    async updateAppProperties(fileId, properties) {
      const file = requireFile(fileId);
      file.appProperties = { ...file.appProperties, ...properties };
    },
  };
}

function createFakeSheetsGateway(store: FakeGoogleStore, actorEmail: string): SheetsGateway {
  function requireFile(fileId: string): FakeFile {
    const file = store.files.get(fileId);
    if (!file || !isAddressable(file, actorEmail)) throw new FileUnavailableError("not-found");
    return file;
  }

  function requireSheetByTitle(file: FakeFile, title: string): FakeSheet {
    const sheet = file.sheets.find((candidate) => candidate.title === title);
    if (!sheet) throw new Error(`The E2E store has no sheet "${title}" in "${file.id}".`);
    return sheet;
  }

  return {
    async getSpreadsheet(fileId): Promise<SpreadsheetSnapshot> {
      const file = requireFile(fileId);
      return { spreadsheetId: file.id, sheets: file.sheets.map(toSheetSummary) };
    },

    async batchUpdate(fileId, requests): Promise<BatchUpdateResult> {
      const file = requireFile(fileId);
      return {
        spreadsheetId: file.id,
        replies: requests.map((request) => applyRequest(store, file, request)),
      };
    },

    async getValues(fileId, ranges): Promise<RangeValues[]> {
      const file = requireFile(fileId);

      return ranges.map((range) => {
        const parsed = parseRange(range);
        const sheet = requireSheetByTitle(file, parsed.title);
        const endRow = parsed.endRow ?? Math.max(sheet.maxRow, parsed.startRow - 1);
        const values: CellValue[][] = [];

        for (let row = parsed.startRow; row <= endRow; row += 1) {
          const cells: CellValue[] = [];
          for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
            cells.push(sheet.cells.get(cellKey(row, column)) ?? "");
          }
          values.push(cells);
        }

        return { range, values };
      });
    },

    async updateValues(fileId, patches: ValuePatch[]): Promise<void> {
      const file = requireFile(fileId);

      if (store.faults.attendanceSaveFailures > 0) {
        store.faults.attendanceSaveFailures -= 1;
        throw new Error("Google Sheets refused this write.");
      }

      for (const patch of patches) {
        const parsed = parseRange(patch.range);
        const sheet = requireSheetByTitle(file, parsed.title);

        patch.values.forEach((row, rowOffset) => {
          row.forEach((value, columnOffset) => {
            writeCell(sheet, parsed.startRow + rowOffset, parsed.startColumn + columnOffset, value);
          });
        });
      }
    },
  };
}

export interface FakeGoogleGateways {
  drive: DriveGateway;
  sheets: SheetsGateway;
}

/**
 * Builds gateways bound to one deterministic identity.
 *
 * The caller has already consulted `resolveTestMode`; nothing in this module
 * decides on its own whether the adapter is allowed.
 */
export function createFakeGoogleGateways(accessToken: string): FakeGoogleGateways {
  const store = getFakeGoogleStore();
  const actorEmail = readTestActorEmail(accessToken);

  return {
    drive: createFakeDriveGateway(store, actorEmail),
    sheets: createFakeSheetsGateway(store, actorEmail),
  };
}
