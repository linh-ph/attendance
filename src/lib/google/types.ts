/**
 * Typed Google boundary contracts.
 *
 * Nothing in this module imports `googleapis`. Services depend on the gateway
 * interfaces below; only `client.ts` adapts the real Google Node client onto
 * the transport shapes at the bottom of this file.
 */

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Case-sensitive substring applied after Drive returns spreadsheet candidates. */
export const ATTENDANCE_NAME_MARKER = "勤怠管理表";

export const FOLDER_METADATA_FIELDS =
  "id,name,mimeType,trashed,ownedByMe,driveId,capabilities(canAddChildren)";

export const FILE_ACCESS_FIELDS =
  "id,name,mimeType,trashed,ownedByMe,owners(emailAddress),appProperties,capabilities(canEdit)";

export const FILE_SUMMARY_FIELDS =
  "nextPageToken,files(id,name,ownedByMe,sharedWithMe,owners(emailAddress),appProperties,modifiedTime)";

export const CREATED_FILE_FIELDS = "id,name";

export const SPREADSHEET_SNAPSHOT_FIELDS =
  "spreadsheetId,sheets(properties(sheetId,title,index,hidden),protectedRanges(protectedRangeId,range(sheetId)))";

export const DRIVE_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Domain-facing shapes                                                        */
/* -------------------------------------------------------------------------- */

export interface DriveFolder {
  id: string;
  name: string;
}

export interface AttendanceFileSummary {
  id: string;
  name: string;
  ownedByMe: boolean;
  sharedWithMe: boolean;
  ownerEmail: string | null;
  appProperties: Record<string, string>;
  modifiedTime: string | null;
}

export interface DriveFileAccess {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  ownedByMe: boolean;
  ownerEmail: string | null;
  appProperties: Record<string, string>;
  canEdit: boolean;
}

export interface CreatedDriveFile {
  id: string;
  name: string;
}

export interface CreateDriveSpreadsheetInput {
  name: string;
  folderId: string;
  appProperties?: Record<string, string>;
}

export interface ConvertXlsxInput {
  name: string;
  folderId: string;
  /** The unmodified uploaded workbook bytes. */
  content: Uint8Array;
  appProperties?: Record<string, string>;
}

export type CellValue = string | number | boolean | null;

export interface ProtectedRangeSummary {
  protectedRangeId: number;
  sheetId: number | null;
}

export interface SheetSummary {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
  protectedRanges: ProtectedRangeSummary[];
}

export interface SpreadsheetSnapshot {
  spreadsheetId: string;
  sheets: SheetSummary[];
}

/** A Sheets `batchUpdate` request object in REST JSON form. */
export type SheetRequest = Record<string, unknown>;

export interface SheetBatchReply {
  addSheet?: { sheetId: number; title: string };
  addProtectedRange?: { protectedRangeId: number };
}

export interface BatchUpdateResult {
  spreadsheetId: string;
  replies: SheetBatchReply[];
}

export interface RangeValues {
  range: string;
  values: CellValue[][];
}

/** One `values.batchUpdate` entry exactly as the Sheets REST API accepts it. */
export interface ValueRangePayload {
  range: string;
  values: CellValue[][];
}

/**
 * How Sheets interprets a written value.
 *
 * `USER_ENTERED` is the default because column H must keep its `=F-G-E`
 * formula contract. Free-text cells — notes (`I`) and the work-report slots
 * (`J:AS`) — must be sent as `RAW`, otherwise a note beginning with `=` or `+`
 * becomes a formula and a note like `2026-07` is coerced into a date.
 */
export type ValueInputOption = "RAW" | "USER_ENTERED";

export interface ValuePatch extends ValueRangePayload {
  /** Defaults to `USER_ENTERED` when omitted, preserving the formula contract. */
  inputOption?: ValueInputOption;
}

/* -------------------------------------------------------------------------- */
/* Gateway interfaces                                                          */
/* -------------------------------------------------------------------------- */

export interface DriveGateway {
  validateManagerFolder(folderId: string): Promise<DriveFolder>;
  listManagerFiles(folderId: string): Promise<AttendanceFileSummary[]>;
  listEmployeeCandidates(): Promise<AttendanceFileSummary[]>;
  getFileAccess(fileId: string): Promise<DriveFileAccess>;
  createSpreadsheetFile(input: CreateDriveSpreadsheetInput): Promise<CreatedDriveFile>;
  convertXlsx(input: ConvertXlsxInput): Promise<CreatedDriveFile>;
  createWriterPermission(fileId: string, email: string): Promise<string>;
  updateAppProperties(fileId: string, properties: Record<string, string>): Promise<void>;
}

export interface SheetsGateway {
  getSpreadsheet(fileId: string, fields?: string): Promise<SpreadsheetSnapshot>;
  batchUpdate(fileId: string, requests: SheetRequest[]): Promise<BatchUpdateResult>;
  getValues(fileId: string, ranges: string[]): Promise<RangeValues[]>;
  updateValues(fileId: string, patches: ValuePatch[]): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Transport shapes (structurally compatible with the Google Node client)      */
/* -------------------------------------------------------------------------- */

export interface DriveFileResource {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
  ownedByMe?: boolean | null;
  sharedWithMe?: boolean | null;
  driveId?: string | null;
  modifiedTime?: string | null;
  appProperties?: Record<string, string> | null;
  owners?: { emailAddress?: string | null }[] | null;
  capabilities?: { canAddChildren?: boolean | null; canEdit?: boolean | null } | null;
}

export interface DriveGetParams {
  fileId: string;
  fields: string;
  supportsAllDrives?: boolean;
}

export interface DriveListParams {
  q: string;
  fields: string;
  pageSize?: number;
  pageToken?: string;
  spaces?: string;
}

export interface DriveCreateParams {
  requestBody: {
    name: string;
    mimeType: string;
    parents: string[];
    appProperties?: Record<string, string>;
  };
  media?: { mimeType: string; body: Uint8Array };
  fields: string;
}

export interface DriveUpdateParams {
  fileId: string;
  requestBody: { appProperties: Record<string, string> };
  fields: string;
}

export interface DrivePermissionCreateParams {
  fileId: string;
  sendNotificationEmail: boolean;
  requestBody: { type: "user"; role: "writer"; emailAddress: string };
  fields: string;
}

export interface DriveClient {
  files: {
    get(params: DriveGetParams): Promise<{ data: DriveFileResource }>;
    list(params: DriveListParams): Promise<{
      data: { files?: DriveFileResource[] | null; nextPageToken?: string | null };
    }>;
    create(params: DriveCreateParams): Promise<{ data: DriveFileResource }>;
    update(params: DriveUpdateParams): Promise<{ data: DriveFileResource }>;
  };
  permissions: {
    create(params: DrivePermissionCreateParams): Promise<{ data: { id?: string | null } }>;
  };
}

export interface SheetPropertiesResource {
  sheetId?: number | null;
  title?: string | null;
  index?: number | null;
  hidden?: boolean | null;
}

export interface SheetResource {
  properties?: SheetPropertiesResource | null;
  protectedRanges?:
    | { protectedRangeId?: number | null; range?: { sheetId?: number | null } | null }[]
    | null;
}

export interface SpreadsheetResource {
  spreadsheetId?: string | null;
  sheets?: SheetResource[] | null;
}

export interface SheetReplyResource {
  addSheet?: { properties?: SheetPropertiesResource | null } | null;
  addProtectedRange?: {
    protectedRange?: { protectedRangeId?: number | null } | null;
  } | null;
}

export interface ValueRangeResource {
  range?: string | null;
  values?: unknown[][] | null;
}

export interface SpreadsheetGetParams {
  spreadsheetId: string;
  fields: string;
}

export interface SpreadsheetsBatchUpdateParams {
  spreadsheetId: string;
  requestBody: { requests: SheetRequest[] };
}

export interface ValuesBatchGetParams {
  spreadsheetId: string;
  ranges: string[];
  valueRenderOption: string;
}

export interface ValuesBatchUpdateParams {
  spreadsheetId: string;
  requestBody: { valueInputOption: string; data: ValueRangePayload[] };
}

export interface SheetsClient {
  spreadsheets: {
    get(params: SpreadsheetGetParams): Promise<{ data: SpreadsheetResource }>;
    batchUpdate(params: SpreadsheetsBatchUpdateParams): Promise<{
      data: { spreadsheetId?: string | null; replies?: SheetReplyResource[] | null };
    }>;
    values: {
      batchGet(params: ValuesBatchGetParams): Promise<{
        data: { valueRanges?: ValueRangeResource[] | null };
      }>;
      batchUpdate(params: ValuesBatchUpdateParams): Promise<{ data: unknown }>;
    };
  };
}
