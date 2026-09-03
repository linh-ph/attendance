export const CONFIG_SHEET_TITLE = "__APP_CONFIG";
export const CONFIG_SETTINGS_RANGE = `${CONFIG_SHEET_TITLE}!A1:B5`;
export const CONFIG_STATUS_RANGE = `${CONFIG_SHEET_TITLE}!D1:F`;
export const CONFIG_MEMBER_RANGE = `${CONFIG_SHEET_TITLE}!H1:N`;

export const SUPPORTED_SCHEMA_VERSION = 1;

export const SETUP_STATES = ["pending", "ready", "needs-repair"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export const SETTINGS_KEYS = [
  "schemaVersion",
  "setupState",
  "month",
  "ownerEmail",
  "templateVersion",
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export const STATUS_TABLE_HEADER = ["code", "labelEn", "sheetValue"] as const;
export const MEMBER_TABLE_HEADER = [
  "displayName",
  "email",
  "sheetId",
  "sheetTitle",
  "protectionId",
  "permissionId",
  "setupStatus",
] as const;

export interface ConfigStatus {
  code: string;
  labelEn: string;
  sheetValue: string;
}

export interface ConfigMember {
  displayName: string;
  email: string;
  sheetId: string | null;
  sheetTitle: string | null;
  protectionId: string | null;
  permissionId: string | null;
  setupStatus: string;
}

export interface AppConfig {
  schemaVersion: number;
  setupState: SetupState;
  month: string;
  ownerEmail: string;
  templateVersion: number;
  statuses: ConfigStatus[];
  members: ConfigMember[];
}

export type RawRow = ReadonlyArray<string>;

export interface RawAppConfig {
  settings: ReadonlyArray<RawRow>;
  statuses: ReadonlyArray<RawRow>;
  members: ReadonlyArray<RawRow>;
}

export interface SerializedAppConfig {
  settings: string[][];
  statuses: string[][];
  members: string[][];
}

export type ConfigTable = "settings" | "statuses" | "members";

export type AppConfigIssueCode =
  | "unsupported-schema-version"
  | "missing-setting"
  | "unknown-setting"
  | "duplicate-setting"
  | "invalid-setting-value"
  | "missing-header"
  | "invalid-header"
  | "invalid-row-width"
  | "invalid-status-row"
  | "duplicate-status-code"
  | "invalid-member-row"
  | "duplicate-member-email"
  | "duplicate-member-sheet-id";

export class AppConfigError extends Error {
  readonly code: AppConfigIssueCode;
  readonly table: ConfigTable;
  readonly row: number | null;
  readonly field: string | null;

  constructor(
    code: AppConfigIssueCode,
    table: ConfigTable,
    message: string,
    details: { row?: number; field?: string } = {},
  ) {
    super(message);
    this.name = "AppConfigError";
    this.code = code;
    this.table = table;
    this.row = details.row ?? null;
    this.field = details.field ?? null;
  }
}

export function isAppConfigError(value: unknown): value is AppConfigError {
  return value instanceof AppConfigError;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

function fail(
  code: AppConfigIssueCode,
  table: ConfigTable,
  message: string,
  details: { row?: number; field?: string } = {},
): never {
  throw new AppConfigError(code, table, message, details);
}

function cell(row: RawRow, index: number): string {
  return (row[index] ?? "").trim();
}

function isBlankRow(row: RawRow): boolean {
  return row.every((value) => (value ?? "").trim() === "");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function readSettings(rows: ReadonlyArray<RawRow>): Map<SettingsKey, string> {
  const settings = new Map<SettingsKey, string>();

  for (const row of rows) {
    if (isBlankRow(row)) continue;

    const key = cell(row, 0);
    if (!SETTINGS_KEYS.includes(key as SettingsKey)) {
      fail("unknown-setting", "settings", `Unknown config setting "${key}".`, { field: key });
    }
    if (settings.has(key as SettingsKey)) {
      fail("duplicate-setting", "settings", `Config setting "${key}" appears more than once.`, { field: key });
    }

    settings.set(key as SettingsKey, cell(row, 1));
  }

  for (const key of SETTINGS_KEYS) {
    if (!settings.has(key)) {
      fail("missing-setting", "settings", `Config setting "${key}" is missing.`, { field: key });
    }
  }

  return settings;
}

function requireSetting(settings: Map<SettingsKey, string>, key: SettingsKey): string {
  return settings.get(key) ?? "";
}

function readSchemaVersion(settings: Map<SettingsKey, string>): number {
  const raw = requireSetting(settings, "schemaVersion");
  if (!POSITIVE_INTEGER_PATTERN.test(raw) || Number(raw) !== SUPPORTED_SCHEMA_VERSION) {
    fail(
      "unsupported-schema-version",
      "settings",
      `Unsupported config schemaVersion "${raw}". Only version ${SUPPORTED_SCHEMA_VERSION} is readable.`,
      { field: "schemaVersion" },
    );
  }

  return SUPPORTED_SCHEMA_VERSION;
}

function readTable(
  rows: ReadonlyArray<RawRow>,
  header: ReadonlyArray<string>,
  table: ConfigTable,
): string[][] {
  const headerRow = rows.at(0);
  if (!headerRow || isBlankRow(headerRow)) {
    fail("missing-header", table, `The ${table} table is missing its header row.`);
  }

  header.forEach((expected, index) => {
    const actual = cell(headerRow, index);
    if (actual !== expected) {
      fail(
        "invalid-header",
        table,
        `The ${table} table header column ${index + 1} must be "${expected}" but was "${actual}".`,
        { field: expected },
      );
    }
  });

  if (headerRow.slice(header.length).some((value) => (value ?? "").trim() !== "")) {
    fail("invalid-header", table, `The ${table} table header has more than ${header.length} columns.`);
  }

  const dataRows: string[][] = [];

  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) break;
    if (row.slice(header.length).some((value) => (value ?? "").trim() !== "")) {
      fail(
        "invalid-row-width",
        table,
        `Row ${dataRows.length + 1} of the ${table} table has more than ${header.length} columns.`,
        { row: dataRows.length + 1 },
      );
    }

    dataRows.push(header.map((_column, index) => cell(row, index)));
  }

  return dataRows;
}

function readStatuses(rows: ReadonlyArray<RawRow>): ConfigStatus[] {
  const dataRows = readTable(rows, STATUS_TABLE_HEADER, "statuses");
  const statuses: ConfigStatus[] = [];
  const seenCodes = new Set<string>();

  dataRows.forEach(([code, labelEn, sheetValue], index) => {
    const row = index + 1;
    if (code === "") fail("invalid-status-row", "statuses", `Status row ${row} has no code.`, { row, field: "code" });
    if (labelEn === "") {
      fail("invalid-status-row", "statuses", `Status row ${row} has no labelEn.`, { row, field: "labelEn" });
    }
    if (sheetValue === "") {
      fail("invalid-status-row", "statuses", `Status row ${row} has no sheetValue.`, { row, field: "sheetValue" });
    }
    if (seenCodes.has(code)) {
      fail("duplicate-status-code", "statuses", `Status code "${code}" appears more than once.`, { row, field: "code" });
    }

    seenCodes.add(code);
    statuses.push({ code, labelEn, sheetValue });
  });

  return statuses;
}

function readResourceId(
  value: string,
  table: ConfigTable,
  row: number,
  field: string,
): string | null {
  if (value === "") return null;
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    fail(
      "invalid-member-row",
      table,
      `Member row ${row} has a non-numeric ${field} "${value}".`,
      { row, field },
    );
  }

  return value;
}

/**
 * Exported because discovery reads `H1:N` on its own to map the signed-in
 * person to their tab, and must not carry a second parser for this table: two
 * readers that disagree about a member row is exactly how someone ends up
 * pointed at a colleague's hours.
 *
 * It throws `AppConfigError` on a malformed table. Callers that only want a
 * mapping should treat that as "no mapping" rather than as a failure.
 */
export function readMembers(rows: ReadonlyArray<RawRow>): ConfigMember[] {
  const dataRows = readTable(rows, MEMBER_TABLE_HEADER, "members");
  const members: ConfigMember[] = [];
  const seenEmails = new Set<string>();
  const seenSheetIds = new Set<string>();

  dataRows.forEach((values, index) => {
    const row = index + 1;
    const [displayName, rawEmail, rawSheetId, sheetTitle, rawProtectionId, rawPermissionId, setupStatus] = values;

    if (displayName === "") {
      fail("invalid-member-row", "members", `Member row ${row} has no displayName.`, { row, field: "displayName" });
    }

    const email = normalizeEmail(rawEmail);
    if (!EMAIL_PATTERN.test(email)) {
      fail("invalid-member-row", "members", `Member row ${row} has an invalid email "${rawEmail}".`, {
        row,
        field: "email",
      });
    }
    if (seenEmails.has(email)) {
      fail("duplicate-member-email", "members", `Member email "${email}" appears more than once.`, {
        row,
        field: "email",
      });
    }

    if (setupStatus === "") {
      fail("invalid-member-row", "members", `Member row ${row} has no setupStatus.`, { row, field: "setupStatus" });
    }

    const sheetId = readResourceId(rawSheetId, "members", row, "sheetId");
    if (sheetId !== null && seenSheetIds.has(sheetId)) {
      fail("duplicate-member-sheet-id", "members", `Member sheetId "${sheetId}" appears more than once.`, {
        row,
        field: "sheetId",
      });
    }

    seenEmails.add(email);
    if (sheetId !== null) seenSheetIds.add(sheetId);

    members.push({
      displayName,
      email,
      sheetId,
      sheetTitle: sheetTitle === "" ? null : sheetTitle,
      protectionId: readResourceId(rawProtectionId, "members", row, "protectionId"),
      permissionId: rawPermissionId === "" ? null : rawPermissionId,
      setupStatus,
    });
  });

  return members;
}

export function parseAppConfig(raw: RawAppConfig): AppConfig {
  const settings = readSettings(raw.settings);
  const schemaVersion = readSchemaVersion(settings);

  const setupState = requireSetting(settings, "setupState");
  if (!SETUP_STATES.includes(setupState as SetupState)) {
    fail("invalid-setting-value", "settings", `Unknown setupState "${setupState}".`, { field: "setupState" });
  }

  const month = requireSetting(settings, "month");
  if (!MONTH_PATTERN.test(month)) {
    fail("invalid-setting-value", "settings", `Config month "${month}" must use the YYYY-MM format.`, {
      field: "month",
    });
  }

  const ownerEmail = normalizeEmail(requireSetting(settings, "ownerEmail"));
  if (!EMAIL_PATTERN.test(ownerEmail)) {
    fail("invalid-setting-value", "settings", `Config ownerEmail "${ownerEmail}" is not a valid email address.`, {
      field: "ownerEmail",
    });
  }

  const rawTemplateVersion = requireSetting(settings, "templateVersion");
  if (!POSITIVE_INTEGER_PATTERN.test(rawTemplateVersion) || Number(rawTemplateVersion) < 1) {
    fail("invalid-setting-value", "settings", `Config templateVersion "${rawTemplateVersion}" must be a positive integer.`, {
      field: "templateVersion",
    });
  }

  return {
    schemaVersion,
    setupState: setupState as SetupState,
    month,
    ownerEmail,
    templateVersion: Number(rawTemplateVersion),
    statuses: readStatuses(raw.statuses),
    members: readMembers(raw.members),
  };
}

export function serializeAppConfig(config: AppConfig): SerializedAppConfig {
  return {
    settings: [
      ["schemaVersion", String(config.schemaVersion)],
      ["setupState", config.setupState],
      ["month", config.month],
      ["ownerEmail", config.ownerEmail],
      ["templateVersion", String(config.templateVersion)],
    ],
    statuses: [
      [...STATUS_TABLE_HEADER],
      ...config.statuses.map((status) => [status.code, status.labelEn, status.sheetValue]),
    ],
    members: [
      [...MEMBER_TABLE_HEADER],
      ...config.members.map((member) => [
        member.displayName,
        member.email,
        member.sheetId ?? "",
        member.sheetTitle ?? "",
        member.protectionId ?? "",
        member.permissionId ?? "",
        member.setupStatus,
      ]),
    ],
  };
}
