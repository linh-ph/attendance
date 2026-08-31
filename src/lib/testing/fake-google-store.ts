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
 *
 * The world it starts from is in `fake-google-seed.ts`, its shapes and cell
 * primitives in `fake-google-state.ts`, and the `batchUpdate` request handlers
 * in `fake-google-requests.ts`.
 */

import { normalizeEmail } from "@/lib/config/schema";
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
  type SheetSummary,
  type SheetsGateway,
  type SpreadsheetSnapshot,
  type ValuePatch,
} from "@/lib/google/types";
import { applyRequest } from "./fake-google-requests";
import { E2E_FIXTURE, buildSeededStore } from "./fake-google-seed";
import {
  cellKey,
  makeSheet,
  parseRange,
  writeCell,
  writeMonthGrid,
  type FakeFile,
  type FakeGoogleStore,
  type FakeSheet,
} from "./fake-google-state";

export { E2E_FIXTURE } from "./fake-google-seed";
export type { FakeGoogleStore } from "./fake-google-state";

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
/* Store lifecycle                                                             */
/* -------------------------------------------------------------------------- */

const STORE_KEY = Symbol.for("google-sheets-attendance.e2e.store");

type StoreCarrier = typeof globalThis & { [STORE_KEY]?: FakeGoogleStore };

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
    /**
     * The owner writes the file, everyone it is shared with can edit it. That is
     * all the deterministic world models about sharing, and it is enough for the
     * directory: the browser test needs real addresses back, in a stable order.
     */
    async listPeople(fileId) {
      const file = requireFile(fileId);

      return [
        { email: file.ownerEmail, role: "owner", displayName: null },
        ...[...file.sharedWith]
          .sort()
          .map((email) => ({ email, role: "writer", displayName: null })),
      ];
    },

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

    async createWriterPermission(fileId, email, notify) {
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
