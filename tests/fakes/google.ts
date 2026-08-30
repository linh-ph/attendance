import type {
  DriveClient,
  DriveCreateParams,
  DriveFileResource,
  DriveGetParams,
  DriveListParams,
  DrivePermissionCreateParams,
  DrivePermissionListParams,
  DrivePermissionListResource,
  DrivePermissionResource,
  DriveUpdateParams,
  SheetReplyResource,
  SheetsClient,
  SpreadsheetGetParams,
  SpreadsheetResource,
  SpreadsheetsBatchUpdateParams,
  ValuesBatchGetParams,
  ValuesBatchUpdateParams,
  ValueRangeResource,
} from "@/lib/google/types";

export interface FakeDriveListPage {
  files?: DriveFileResource[];
  nextPageToken?: string;
}

export interface FakeDriveOptions {
  file?: DriveFileResource;
  getError?: unknown;
  listPages?: FakeDriveListPage[];
  createdFile?: DriveFileResource;
  permissionId?: string | null;
  /** A single page of sharing grants. */
  permissions?: DrivePermissionResource[];
  /** Successive pages, when the paging itself is what is under test. */
  permissionPages?: DrivePermissionListResource[];
}

export interface FakeDriveClient extends DriveClient {
  getCalls: DriveGetParams[];
  listCalls: DriveListParams[];
  createCalls: DriveCreateParams[];
  updateCalls: DriveUpdateParams[];
  permissionCalls: DrivePermissionCreateParams[];
  permissionListCalls: DrivePermissionListParams[];
}

export function createFakeDriveClient(options: FakeDriveOptions = {}): FakeDriveClient {
  const getCalls: DriveGetParams[] = [];
  const listCalls: DriveListParams[] = [];
  const createCalls: DriveCreateParams[] = [];
  const updateCalls: DriveUpdateParams[] = [];
  const permissionCalls: DrivePermissionCreateParams[] = [];
  const permissionListCalls: DrivePermissionListParams[] = [];
  const listPages = options.listPages ?? [];

  return {
    getCalls,
    listCalls,
    createCalls,
    updateCalls,
    permissionCalls,
    permissionListCalls,
    files: {
      async get(params) {
        getCalls.push(params);
        if (options.getError) {
          throw options.getError;
        }
        return { data: options.file ?? {} };
      },
      async list(params) {
        const page = listPages[listCalls.length] ?? {};
        listCalls.push(params);
        return { data: { files: page.files ?? [], nextPageToken: page.nextPageToken } };
      },
      async create(params) {
        createCalls.push(params);
        return {
          data: options.createdFile ?? { id: "created-file", name: params.requestBody.name },
        };
      },
      async update(params) {
        updateCalls.push(params);
        return { data: { id: params.fileId } };
      },
    },
    permissions: {
      async create(params) {
        permissionCalls.push(params);
        return { data: { id: options.permissionId ?? `permission-${permissionCalls.length}` } };
      },
      async list(params) {
        permissionListCalls.push(params);
        const pages = options.permissionPages ?? [{ permissions: options.permissions ?? [] }];
        const index = params.pageToken === undefined ? 0 : Number(params.pageToken);
        return { data: pages[index] ?? { permissions: [] } };
      },
    },
  };
}

export interface FakeSheetsOptions {
  spreadsheet?: SpreadsheetResource;
  replies?: SheetReplyResource[];
  valueRanges?: ValueRangeResource[];
}

export interface FakeSheetsClient extends SheetsClient {
  getCalls: SpreadsheetGetParams[];
  batchUpdateCalls: SpreadsheetsBatchUpdateParams[];
  valuesGetCalls: ValuesBatchGetParams[];
  valuesUpdateCalls: ValuesBatchUpdateParams[];
}

export function createFakeSheetsClient(options: FakeSheetsOptions = {}): FakeSheetsClient {
  const getCalls: SpreadsheetGetParams[] = [];
  const batchUpdateCalls: SpreadsheetsBatchUpdateParams[] = [];
  const valuesGetCalls: ValuesBatchGetParams[] = [];
  const valuesUpdateCalls: ValuesBatchUpdateParams[] = [];

  return {
    getCalls,
    batchUpdateCalls,
    valuesGetCalls,
    valuesUpdateCalls,
    spreadsheets: {
      async get(params) {
        getCalls.push(params);
        return { data: options.spreadsheet ?? { spreadsheetId: params.spreadsheetId } };
      },
      async batchUpdate(params) {
        batchUpdateCalls.push(params);
        return {
          data: { spreadsheetId: params.spreadsheetId, replies: options.replies ?? [] },
        };
      },
      values: {
        async batchGet(params) {
          valuesGetCalls.push(params);
          return { data: { valueRanges: options.valueRanges ?? [] } };
        },
        async batchUpdate(params) {
          valuesUpdateCalls.push(params);
          return { data: {} };
        },
      },
    },
  };
}
