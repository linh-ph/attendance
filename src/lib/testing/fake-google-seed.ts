/**
 * The deterministic world the browser proof runs against.
 *
 * The identifiers are named once in `E2E_FIXTURE` so the tests assert against
 * the very values the seed writes, and `buildSeededStore` is the only thing
 * that decides what exists before a test touches anything. The engine in
 * `fake-google-store.ts` never states a fixture of its own.
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
import { SPREADSHEET_MIME_TYPE } from "@/lib/google/types";
import {
  FIRST_CREATED_PROTECTION_ID,
  FIRST_CREATED_SHEET_ID,
  columnIndex,
  makeSheet,
  protect,
  writeCell,
  writeMonthGrid,
  type FakeFile,
  type FakeFolder,
  type FakeGoogleStore,
  type FakeSheet,
} from "./fake-google-state";

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
/* Seed                                                                        */
/* -------------------------------------------------------------------------- */

const SEED_STATUSES: ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

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
export function buildSeededStore(): FakeGoogleStore {
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
