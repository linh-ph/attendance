/**
 * Event-recording fakes for the monthly create/setup flow.
 *
 * The fake models Google state rather than replaying canned responses: created
 * files, sheets, protected ranges, Drive `appProperties`, and an addressable A1
 * cell store. That makes retry assertions meaningful, because a resumed setup
 * reads exactly what the previous attempt actually wrote, through the real
 * `createConfigRepository`.
 *
 * `events` is a phase-level log of the externally observable setup sequence:
 *
 * - `validate-folder:<folderId>`, `create-drive-file:<name>:<folderId>` and
 *   `invite:<email>` are discrete actions and are recorded on every call;
 * - `create-config-and-employee-sheets` is recorded for any batch that adds at
 *   least one sheet and `protect-config-and-employee-sheets` for any batch that
 *   adds at least one protected range. Adjacent calls in the same phase collapse
 *   into a single entry, so "create every tab" stays one observable step while a
 *   phase that is genuinely re-entered later (a retry that recreates tabs)
 *   appears again;
 * - `set-app-properties:<setupState>` is recorded only when the stored Drive
 *   setup state actually changes, because `appProperties` writes are idempotent
 *   state, not actions.
 */

import {
  APP_PROPERTY_SETUP_STATE,
  createConfigRepository,
  type ConfigRepository,
} from "@/lib/config/repository";
import type {
  AttendanceFileSummary,
  BatchUpdateResult,
  CellValue,
  CreateDriveSpreadsheetInput,
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

const CREATE_SHEETS_PHASE = "create-config-and-employee-sheets";
const PROTECT_SHEETS_PHASE = "protect-config-and-employee-sheets";

/** Every spreadsheet Drive creates starts with one default tab. */
const DEFAULT_SHEET_TITLE = "Sheet1";

/* -------------------------------------------------------------------------- */
/* A1 range arithmetic                                                        */
/* -------------------------------------------------------------------------- */

interface ParsedRange {
  title: string;
  startRow: number;
  startColumn: number;
  /** `null` for an open-ended range such as `__APP_CONFIG!H1:N`. */
  endRow: number | null;
  endColumn: number;
}

const RANGE_PATTERN = /^(?:'([^']+)'|([^!]+))!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/;

function columnIndex(letters: string): number {
  let index = 0;
  for (const character of letters) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseRange(range: string): ParsedRange {
  const match = RANGE_PATTERN.exec(range);
  if (!match) {
    throw new Error(`The fake sheet store cannot address "${range}".`);
  }

  const startColumn = columnIndex(match[3]);
  const hasEndColumn = match[5] !== undefined;

  return {
    title: match[1] ?? match[2],
    startRow: Number(match[4]),
    startColumn,
    endRow: match[6] !== undefined ? Number(match[6]) : hasEndColumn ? null : Number(match[4]),
    endColumn: hasEndColumn ? columnIndex(match[5]) : startColumn,
  };
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

/* -------------------------------------------------------------------------- */
/* In-memory spreadsheet state                                                 */
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
  cells: Map<string, CellValue>;
  maxRow: number;
}

interface FakeFile {
  id: string;
  name: string;
  folderId: string;
  appProperties: Record<string, string>;
  sheets: FakeSheet[];
}

export interface GridResize {
  sheetId: number;
  rowCount: number | null;
}

export interface FileDependenciesOptions {
  /** Metadata `validateManagerFolder` returns; defaults to `folder-1`. */
  folder?: DriveFolder;
  /** Thrown by `validateManagerFolder` instead of returning metadata. */
  folderError?: unknown;
  /** File ID assigned to the next created spreadsheet. */
  fileId?: string;
}

export interface FileDependenciesFake {
  /** Ordered phase log described in the module comment. */
  events: string[];
  drive: DriveGateway;
  sheets: SheetsGateway;
  /** The real repository, bound to the fake gateways. */
  config: ConfigRepository;

  /** Every `addSheet` title, in call order, across every batch. */
  addedSheetTitles: string[];
  /** Every `addProtectedRange`, in call order. */
  addedProtections: Array<{ sheetId: number; editors: string[] }>;
  /** Every `deleteSheet` target, in call order. */
  deletedSheetIds: number[];
  /**
   * Every `updateSheetProperties` request that resizes a grid. Replaying one of
   * these onto a populated tab would truncate saved attendance rows.
   */
  gridResizes: GridResize[];
  /** Every `permissions.create` target, in call order. */
  invitedEmails: string[];
  createdFiles: Array<{ id: string; name: string; folderId: string }>;

  /** Live sheet titles of the created file, in order. */
  sheetTitles(fileId?: string): string[];
  appProperties(fileId?: string): Record<string, string>;
  /** Makes the next `createWriterPermission` for `email` fail. */
  failInvite(email: string, error?: unknown): void;
  clearInviteFailures(): void;
  clearEvents(): void;
}

export function createFileDependenciesFake(
  options: FileDependenciesOptions = {},
): FileDependenciesFake {
  const folder: DriveFolder = options.folder ?? { id: "folder-1", name: "Attendance 2026" };
  const events: string[] = [];
  const files = new Map<string, FakeFile>();
  const inviteFailures = new Map<string, unknown>();

  const addedSheetTitles: string[] = [];
  const addedProtections: Array<{ sheetId: number; editors: string[] }> = [];
  const deletedSheetIds: number[] = [];
  const gridResizes: GridResize[] = [];
  const invitedEmails: string[] = [];
  const createdFiles: Array<{ id: string; name: string; folderId: string }> = [];

  let nextFileNumber = 0;
  let nextSheetId = 1;
  let nextProtectionId = 1;
  let nextPermissionId = 1;
  const observedSetupState = new Map<string, string>();

  function recordPhase(phase: string): void {
    if (events.at(-1) === phase) return;
    events.push(phase);
  }

  function requireFile(fileId: string): FakeFile {
    const file = files.get(fileId);
    if (!file) throw new Error(`The fake store has no file "${fileId}".`);
    return file;
  }

  function requireSheet(fileId: string, title: string): FakeSheet {
    const sheet = requireFile(fileId).sheets.find((candidate) => candidate.title === title);
    if (!sheet) throw new Error(`The fake store has no sheet "${title}" in "${fileId}".`);
    return sheet;
  }

  function readRange(fileId: string, range: string): RangeValues {
    const parsed = parseRange(range);
    const sheet = requireSheet(fileId, parsed.title);
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
  }

  function writeRange(fileId: string, patch: ValuePatch): void {
    const parsed = parseRange(patch.range);
    const sheet = requireSheet(fileId, parsed.title);

    patch.values.forEach((row, rowOffset) => {
      const rowNumber = parsed.startRow + rowOffset;
      row.forEach((value, columnOffset) => {
        sheet.cells.set(cellKey(rowNumber, parsed.startColumn + columnOffset), value);
      });
      sheet.maxRow = Math.max(sheet.maxRow, rowNumber);
    });
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

  function applyAppProperties(fileId: string, properties: Record<string, string>): void {
    const file = requireFile(fileId);
    file.appProperties = { ...file.appProperties, ...properties };

    const setupState = file.appProperties[APP_PROPERTY_SETUP_STATE];
    if (setupState !== undefined && observedSetupState.get(fileId) !== setupState) {
      observedSetupState.set(fileId, setupState);
      events.push(`set-app-properties:${setupState}`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* batchUpdate request handling                                            */
  /* ---------------------------------------------------------------------- */

  function readRequest<T>(request: SheetRequest, key: string): T | undefined {
    return request[key] as T | undefined;
  }

  function applyAddSheet(file: FakeFile, request: SheetRequest): SheetBatchReply {
    const properties =
      readRequest<{ properties?: { title?: string; hidden?: boolean; sheetId?: number } }>(
        request,
        "addSheet",
      )?.properties ?? {};
    const title = properties.title ?? `Sheet${file.sheets.length + 1}`;

    if (file.sheets.some((sheet) => sheet.title === title)) {
      throw new Error(`A sheet named "${title}" already exists.`);
    }

    const sheet: FakeSheet = {
      sheetId: properties.sheetId ?? nextSheetId++,
      title,
      hidden: properties.hidden === true,
      protectedRanges: [],
      cells: new Map(),
      maxRow: 0,
    };

    file.sheets.push(sheet);
    addedSheetTitles.push(title);

    return { addSheet: { sheetId: sheet.sheetId, title } };
  }

  function applyDeleteSheet(file: FakeFile, request: SheetRequest): SheetBatchReply {
    const sheetId = readRequest<{ sheetId?: number }>(request, "deleteSheet")?.sheetId;
    const index = file.sheets.findIndex((sheet) => sheet.sheetId === sheetId);

    if (index === -1) {
      throw new Error(`The fake store has no sheet ${String(sheetId)} to delete.`);
    }

    file.sheets.splice(index, 1);
    deletedSheetIds.push(sheetId as number);

    return {};
  }

  function applyAddProtectedRange(file: FakeFile, request: SheetRequest): SheetBatchReply {
    const protectedRange =
      readRequest<{
        protectedRange?: {
          range?: { sheetId?: number };
          editors?: { users?: string[] };
        };
      }>(request, "addProtectedRange")?.protectedRange ?? {};

    const sheetId = protectedRange.range?.sheetId;
    const sheet = file.sheets.find((candidate) => candidate.sheetId === sheetId);
    if (!sheet) {
      throw new Error(`The fake store cannot protect missing sheet ${String(sheetId)}.`);
    }

    const editors = protectedRange.editors?.users ?? [];
    const protectedRangeId = nextProtectionId++;
    sheet.protectedRanges.push({ protectedRangeId, sheetId: sheet.sheetId, editors });
    addedProtections.push({ sheetId: sheet.sheetId, editors });

    return { addProtectedRange: { protectedRangeId } };
  }

  function applyUpdateSheetProperties(file: FakeFile, request: SheetRequest): SheetBatchReply {
    const properties =
      readRequest<{
        properties?: { sheetId?: number; hidden?: boolean; gridProperties?: { rowCount?: number } };
      }>(request, "updateSheetProperties")?.properties ?? {};

    const sheet = file.sheets.find((candidate) => candidate.sheetId === properties.sheetId);
    if (!sheet) {
      throw new Error(`The fake store has no sheet ${String(properties.sheetId)} to update.`);
    }

    if (properties.hidden !== undefined) {
      sheet.hidden = properties.hidden;
    }

    if (properties.gridProperties !== undefined) {
      gridResizes.push({
        sheetId: sheet.sheetId,
        rowCount: properties.gridProperties.rowCount ?? null,
      });
    }

    return {};
  }

  function applyRequest(file: FakeFile, request: SheetRequest): SheetBatchReply {
    if (request.addSheet !== undefined) return applyAddSheet(file, request);
    if (request.deleteSheet !== undefined) return applyDeleteSheet(file, request);
    if (request.addProtectedRange !== undefined) return applyAddProtectedRange(file, request);
    if (request.updateSheetProperties !== undefined) {
      return applyUpdateSheetProperties(file, request);
    }

    // updateCells / mergeCells / repeatCell / setDataValidation carry no reply
    // and no state this fake needs to model.
    return {};
  }

  /* ---------------------------------------------------------------------- */
  /* Gateways                                                                */
  /* ---------------------------------------------------------------------- */

  const drive: DriveGateway = {
    async listPeople(): Promise<never[]> {
      return [];
    },
    async validateManagerFolder(folderId: string): Promise<DriveFolder> {
      events.push(`validate-folder:${folderId}`);
      if (options.folderError) throw options.folderError;
      return folder;
    },

    async listManagerFiles(): Promise<AttendanceFileSummary[]> {
      return [];
    },

    async listEmployeeCandidates(): Promise<AttendanceFileSummary[]> {
      return [];
    },

    async getFileAccess(fileId: string): Promise<DriveFileAccess> {
      const file = requireFile(fileId);
      return {
        id: file.id,
        name: file.name,
        mimeType: "application/vnd.google-apps.spreadsheet",
        trashed: false,
        ownedByMe: true,
        ownerEmail: null,
        appProperties: { ...file.appProperties },
        canEdit: true,
      };
    },

    async createSpreadsheetFile(input: CreateDriveSpreadsheetInput): Promise<CreatedDriveFile> {
      const id = nextFileNumber === 0 ? (options.fileId ?? "file-1") : `file-${nextFileNumber + 1}`;
      nextFileNumber += 1;

      files.set(id, {
        id,
        name: input.name,
        folderId: input.folderId,
        appProperties: {},
        sheets: [
          {
            sheetId: 0,
            title: DEFAULT_SHEET_TITLE,
            hidden: false,
            protectedRanges: [],
            cells: new Map(),
            maxRow: 0,
          },
        ],
      });

      createdFiles.push({ id, name: input.name, folderId: input.folderId });
      events.push(`create-drive-file:${input.name}:${input.folderId}`);

      if (input.appProperties) {
        applyAppProperties(id, input.appProperties);
      }

      return { id, name: input.name };
    },

    async convertXlsx(): Promise<CreatedDriveFile> {
      throw new Error("convertXlsx is not part of the create flow.");
    },

    async createWriterPermission(fileId: string, email: string): Promise<string> {
      requireFile(fileId);
      events.push(`invite:${email}`);
      invitedEmails.push(email);

      const failure = inviteFailures.get(email);
      if (failure !== undefined) {
        throw failure;
      }

      return `permission-${nextPermissionId++}`;
    },

    async updateAppProperties(fileId: string, properties: Record<string, string>): Promise<void> {
      applyAppProperties(fileId, properties);
    },
  };

  const sheets: SheetsGateway = {
    async getSpreadsheet(fileId: string): Promise<SpreadsheetSnapshot> {
      const file = requireFile(fileId);
      return { spreadsheetId: file.id, sheets: file.sheets.map(toSheetSummary) };
    },

    async batchUpdate(fileId: string, requests: SheetRequest[]): Promise<BatchUpdateResult> {
      const file = requireFile(fileId);

      if (requests.some((request) => request.addSheet !== undefined)) {
        recordPhase(CREATE_SHEETS_PHASE);
      }
      if (requests.some((request) => request.addProtectedRange !== undefined)) {
        recordPhase(PROTECT_SHEETS_PHASE);
      }

      return { spreadsheetId: file.id, replies: requests.map((request) => applyRequest(file, request)) };
    },

    async getValues(fileId: string, ranges: string[]): Promise<RangeValues[]> {
      return ranges.map((range) => readRange(fileId, range));
    },

    async updateValues(fileId: string, patches: ValuePatch[]): Promise<void> {
      for (const patch of patches) {
        writeRange(fileId, patch);
      }
    },
  };

  const firstFileId = (): string => {
    const first = createdFiles.at(0);
    if (!first) throw new Error("The fake store has not created a file yet.");
    return first.id;
  };

  return {
    events,
    drive,
    sheets,
    config: createConfigRepository({ sheets, drive }),
    addedSheetTitles,
    addedProtections,
    deletedSheetIds,
    gridResizes,
    invitedEmails,
    createdFiles,
    sheetTitles(fileId = firstFileId()) {
      return requireFile(fileId).sheets.map((sheet) => sheet.title);
    },
    appProperties(fileId = firstFileId()) {
      return { ...requireFile(fileId).appProperties };
    },
    failInvite(email, error = new Error("Drive refused the invitation.")) {
      inviteFailures.set(email, error);
    },
    clearInviteFailures() {
      inviteFailures.clear();
    },
    clearEvents() {
      events.length = 0;
    },
  };
}
