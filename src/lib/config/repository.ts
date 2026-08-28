/**
 * Sheet-native `__APP_CONFIG` repository.
 *
 * The repository owns the fixed version-1 coordinates from the approved design
 * (`A1:B5` settings, `D1:F` statuses, `H1:N` members) and the Drive
 * `appProperties` contract. It depends only on the `SheetsGateway` and
 * `DriveGateway` interfaces so it never reaches `googleapis` directly.
 *
 * Writes are deliberately narrow: `updateMemberProgress` patches a single member
 * row and `updateSetupState` patches a single settings cell, so a partially
 * completed setup is never overwritten by an unrelated range.
 */

import type {
  CellValue,
  DriveGateway,
  SheetRequest,
  SheetsGateway,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import {
  CONFIG_MEMBER_RANGE,
  CONFIG_SETTINGS_RANGE,
  CONFIG_SHEET_TITLE,
  CONFIG_STATUS_RANGE,
  SETTINGS_KEYS,
  SUPPORTED_SCHEMA_VERSION,
  normalizeEmail,
  parseAppConfig,
  serializeAppConfig,
  type AppConfig,
  type ConfigMember,
  type ConfigStatus,
  type SetupState,
} from "./schema";

/* -------------------------------------------------------------------------- */
/* Drive appProperties contract                                                */
/* -------------------------------------------------------------------------- */

export const APP_PROPERTY_APP = "attendanceApp";
export const APP_PROPERTY_SETUP_STATE = "attendanceSetupState";
export const APP_PROPERTY_MONTH = "attendanceMonth";
export const APP_PROPERTY_APP_VERSION = "v1";

/** The exact appProperties written when a file is first configured. */
export function buildAppProperties(month: string, setupState: SetupState): Record<string, string> {
  return {
    [APP_PROPERTY_APP]: APP_PROPERTY_APP_VERSION,
    [APP_PROPERTY_SETUP_STATE]: setupState,
    [APP_PROPERTY_MONTH]: month,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived single-cell / single-row coordinates                                */
/* -------------------------------------------------------------------------- */

const SETTINGS_VALUE_COLUMN = "B";
const MEMBER_FIRST_COLUMN = "H";
const MEMBER_LAST_COLUMN = "N";
const MEMBER_HEADER_ROWS = 1;

/** `__APP_CONFIG!B2` — derived from the settings key order, not hardcoded twice. */
export const CONFIG_SETUP_STATE_CELL = `${CONFIG_SHEET_TITLE}!${SETTINGS_VALUE_COLUMN}${
  SETTINGS_KEYS.indexOf("setupState") + 1
}`;

/** The `H..N` row range for the member at `index` in the parsed member list. */
export function configMemberRowRange(index: number): string {
  const row = index + MEMBER_HEADER_ROWS + 1;
  return `${CONFIG_SHEET_TITLE}!${MEMBER_FIRST_COLUMN}${row}:${MEMBER_LAST_COLUMN}${row}`;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConfigRepositoryErrorCode =
  | "config-missing"
  | "config-sheet-exists"
  | "config-write-incomplete";

export class ConfigRepositoryError extends Error {
  readonly code: ConfigRepositoryErrorCode;
  readonly fileId: string;

  constructor(code: ConfigRepositoryErrorCode, fileId: string, message: string) {
    super(message);
    this.name = "ConfigRepositoryError";
    this.code = code;
    this.fileId = fileId;
  }
}

/** The file has no `__APP_CONFIG` sheet, so it has never been configured. */
export class ConfigMissingError extends ConfigRepositoryError {
  constructor(fileId: string) {
    super("config-missing", fileId, "This file has no attendance configuration sheet.");
    this.name = "ConfigMissingError";
  }
}

/** `initialize` refused to overwrite an existing configuration sheet. */
export class ConfigSheetExistsError extends ConfigRepositoryError {
  constructor(fileId: string) {
    super(
      "config-sheet-exists",
      fileId,
      "This file already has an attendance configuration sheet. Replacing it must be explicit.",
    );
    this.name = "ConfigSheetExistsError";
  }
}

export function isConfigRepositoryError(value: unknown): value is ConfigRepositoryError {
  return value instanceof ConfigRepositoryError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface ConfigReadResult {
  fileId: string;
  config: AppConfig;
  /** Numeric sheet ID of the hidden `__APP_CONFIG` sheet. */
  configSheetId: number;
  /** The snapshot used to locate the config sheet; reused to avoid a second fetch. */
  spreadsheet: SpreadsheetSnapshot;
}

export interface InitializeConfigInput {
  fileId: string;
  /** `YYYY-MM`. */
  month: string;
  ownerEmail: string;
  statuses: ConfigStatus[];
  members: ConfigMember[];
  templateVersion?: number;
  /** Explicit opt-in required to delete and rewrite an untrusted uploaded config sheet. */
  replaceExisting?: boolean;
}

export interface InitializedConfig {
  /** Numeric sheet ID of the created config sheet, stored as a string. */
  sheetId: string;
  /** Numeric protected-range ID of the owner-only protection, stored as a string. */
  protectionId: string;
  config: AppConfig;
}

export interface MemberProgressUpdate {
  /** Member identity; normalized before lookup and storage. */
  email: string;
  displayName?: string;
  sheetId?: string | number | null;
  sheetTitle?: string | null;
  protectionId?: string | number | null;
  permissionId?: string | null;
  setupStatus?: string;
}

export interface ConfigRepository {
  read(fileId: string): Promise<ConfigReadResult>;
  initialize(input: InitializeConfigInput): Promise<InitializedConfig>;
  /** Upserts one member row by normalized email and writes only that row. */
  updateMemberProgress(fileId: string, update: MemberProgressUpdate): Promise<ConfigMember>;
  /** Writes only the setup-state settings cell and the setup-state app property. */
  updateSetupState(fileId: string, setupState: SetupState): Promise<void>;
}

export interface ConfigRepositoryDependencies {
  sheets: SheetsGateway;
  drive: DriveGateway;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const CONFIG_RANGES = [CONFIG_SETTINGS_RANGE, CONFIG_STATUS_RANGE, CONFIG_MEMBER_RANGE] as const;

const CONFIG_PROTECTION_DESCRIPTION = "Attendance app configuration";

function toCellString(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function toRows(values: CellValue[][] | undefined): string[][] {
  return (values ?? []).map((row) => row.map(toCellString));
}

/** Google resource IDs are numeric on the wire and stored as strings. */
function toResourceId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === "number" ? String(value) : value.trim();
  return normalized === "" ? null : normalized;
}

/**
 * Round-trips a candidate config through the committed serializer/parser so
 * every write is validated by exactly the same rules that guard reads.
 */
function validateConfig(candidate: AppConfig): AppConfig {
  const serialized = serializeAppConfig(candidate);
  return parseAppConfig({
    settings: serialized.settings,
    statuses: serialized.statuses,
    members: serialized.members,
  });
}

function findConfigSheetId(snapshot: SpreadsheetSnapshot): number | null {
  const configSheet = snapshot.sheets.find((sheet) => sheet.title === CONFIG_SHEET_TITLE);
  return configSheet ? configSheet.sheetId : null;
}

function memberRowValues(member: ConfigMember): string[] {
  return [
    member.displayName,
    member.email,
    member.sheetId ?? "",
    member.sheetTitle ?? "",
    member.protectionId ?? "",
    member.permissionId ?? "",
    member.setupStatus,
  ];
}

function mergeMember(current: ConfigMember, update: MemberProgressUpdate): ConfigMember {
  return {
    displayName: update.displayName ?? current.displayName,
    email: current.email,
    sheetId: update.sheetId === undefined ? current.sheetId : toResourceId(update.sheetId),
    sheetTitle: update.sheetTitle === undefined ? current.sheetTitle : update.sheetTitle,
    protectionId:
      update.protectionId === undefined ? current.protectionId : toResourceId(update.protectionId),
    permissionId:
      update.permissionId === undefined ? current.permissionId : update.permissionId,
    setupStatus: update.setupStatus ?? current.setupStatus,
  };
}

function buildAddSheetRequest(): SheetRequest {
  return { addSheet: { properties: { title: CONFIG_SHEET_TITLE, hidden: true } } };
}

function buildOwnerOnlyProtectionRequest(sheetId: number, ownerEmail: string): SheetRequest {
  return {
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: CONFIG_PROTECTION_DESCRIPTION,
        warningOnly: false,
        requestingUserCanEdit: false,
        editors: { users: [ownerEmail], groups: [], domainUsersCanEdit: false },
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createConfigRepository(
  dependencies: ConfigRepositoryDependencies,
): ConfigRepository {
  const { sheets, drive } = dependencies;

  async function read(fileId: string): Promise<ConfigReadResult> {
    const spreadsheet = await sheets.getSpreadsheet(fileId);
    const configSheetId = findConfigSheetId(spreadsheet);

    if (configSheetId === null) {
      throw new ConfigMissingError(fileId);
    }

    const ranges = await sheets.getValues(fileId, [...CONFIG_RANGES]);
    const config = parseAppConfig({
      settings: toRows(ranges.at(0)?.values),
      statuses: toRows(ranges.at(1)?.values),
      members: toRows(ranges.at(2)?.values),
    });

    return { fileId, config, configSheetId, spreadsheet };
  }

  async function initialize(input: InitializeConfigInput): Promise<InitializedConfig> {
    const ownerEmail = normalizeEmail(input.ownerEmail);
    const config = validateConfig({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      setupState: "pending",
      month: input.month,
      ownerEmail,
      templateVersion: input.templateVersion ?? 1,
      statuses: input.statuses,
      members: input.members.map((member) => ({
        ...member,
        email: normalizeEmail(member.email),
        sheetId: toResourceId(member.sheetId),
        protectionId: toResourceId(member.protectionId),
      })),
    });

    const snapshot = await sheets.getSpreadsheet(input.fileId);
    const existingSheetId = findConfigSheetId(snapshot);

    if (existingSheetId !== null && input.replaceExisting !== true) {
      throw new ConfigSheetExistsError(input.fileId);
    }

    const createRequests: SheetRequest[] =
      existingSheetId === null
        ? [buildAddSheetRequest()]
        : [{ deleteSheet: { sheetId: existingSheetId } }, buildAddSheetRequest()];

    const created = await sheets.batchUpdate(input.fileId, createRequests);
    const addedSheet = created.replies.find((reply) => reply.addSheet !== undefined)?.addSheet;

    if (!addedSheet) {
      throw new ConfigRepositoryError(
        "config-write-incomplete",
        input.fileId,
        "Google did not return the created configuration sheet.",
      );
    }

    const serialized = serializeAppConfig(config);
    await sheets.updateValues(input.fileId, [
      { range: CONFIG_SETTINGS_RANGE, values: serialized.settings },
      { range: CONFIG_STATUS_RANGE, values: serialized.statuses },
      { range: CONFIG_MEMBER_RANGE, values: serialized.members },
    ]);

    const protectedResult = await sheets.batchUpdate(input.fileId, [
      buildOwnerOnlyProtectionRequest(addedSheet.sheetId, ownerEmail),
    ]);
    const addedProtection = protectedResult.replies.find(
      (reply) => reply.addProtectedRange !== undefined,
    )?.addProtectedRange;

    if (!addedProtection) {
      throw new ConfigRepositoryError(
        "config-write-incomplete",
        input.fileId,
        "Google did not return the configuration sheet protection.",
      );
    }

    await drive.updateAppProperties(input.fileId, buildAppProperties(config.month, "pending"));

    return {
      sheetId: String(addedSheet.sheetId),
      protectionId: String(addedProtection.protectedRangeId),
      config,
    };
  }

  async function updateMemberProgress(
    fileId: string,
    update: MemberProgressUpdate,
  ): Promise<ConfigMember> {
    const email = normalizeEmail(update.email);
    const { config } = await read(fileId);

    const index = config.members.findIndex((member) => member.email === email);
    const nextMember =
      index === -1
        ? mergeMember(
            {
              displayName: "",
              email,
              sheetId: null,
              sheetTitle: null,
              protectionId: null,
              permissionId: null,
              setupStatus: "",
            },
            update,
          )
        : mergeMember(config.members[index], update);

    const targetIndex = index === -1 ? config.members.length : index;
    const members =
      index === -1
        ? [...config.members, nextMember]
        : config.members.map((member, position) => (position === targetIndex ? nextMember : member));

    const validated = validateConfig({ ...config, members });
    const storedMember = validated.members[targetIndex];

    await sheets.updateValues(fileId, [
      { range: configMemberRowRange(targetIndex), values: [memberRowValues(storedMember)] },
    ]);

    return storedMember;
  }

  async function updateSetupState(fileId: string, setupState: SetupState): Promise<void> {
    await sheets.updateValues(fileId, [
      { range: CONFIG_SETUP_STATE_CELL, values: [[setupState]] },
    ]);
    await drive.updateAppProperties(fileId, { [APP_PROPERTY_SETUP_STATE]: setupState });
  }

  return { read, initialize, updateMemberProgress, updateSetupState };
}
