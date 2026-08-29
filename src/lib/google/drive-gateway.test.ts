import { describe, expect, it } from "vitest";
import { createFakeDriveClient } from "../../../tests/fakes/google";
import { createDriveGateway } from "./drive-gateway";
import { FolderUnavailableError } from "./errors";
import {
  FOLDER_MIME_TYPE,
  FILE_SUMMARY_FIELDS,
  SPREADSHEET_MIME_TYPE,
  XLSX_MIME_TYPE,
  type DriveFileResource,
} from "./types";

const writableFolder: DriveFileResource = {
  id: "folder-1",
  name: "Attendance 2026",
  mimeType: FOLDER_MIME_TYPE,
  trashed: false,
  ownedByMe: true,
  capabilities: { canAddChildren: true },
};

describe("validateManagerFolder", () => {
  it("resolves a writable owned My Drive folder and requests only the filtering metadata", async () => {
    const fakeDrive = createFakeDriveClient({ file: writableFolder });
    const gateway = createDriveGateway(fakeDrive);

    await expect(gateway.validateManagerFolder("folder-1")).resolves.toEqual({
      id: "folder-1",
      name: "Attendance 2026",
    });

    expect(fakeDrive.getCalls[0].fileId).toBe("folder-1");
    expect(fakeDrive.getCalls[0].fields).toBe(
      "id,name,mimeType,trashed,ownedByMe,driveId,capabilities(canAddChildren)",
    );
  });

  it.each([
    ["a folder owned by somebody else", { ...writableFolder, ownedByMe: false }],
    ["a Shared Drive folder", { ...writableFolder, driveId: "shared-drive-1" }],
  ])("accepts %s that this account can still write to", async (_case, file) => {
    const gateway = createDriveGateway(createFakeDriveClient({ file }));

    await expect(gateway.validateManagerFolder("folder-1")).resolves.toEqual({
      id: "folder-1",
      name: "Attendance 2026",
    });
  });

  it.each([
    ["a non-folder MIME type", { ...writableFolder, mimeType: SPREADSHEET_MIME_TYPE }],
    ["a trashed folder", { ...writableFolder, trashed: true }],
    [
      "a folder that cannot receive children",
      { ...writableFolder, capabilities: { canAddChildren: false } },
    ],
    ["a folder without reported capabilities", { ...writableFolder, capabilities: undefined }],
    ["a folder without an id or name", { ...writableFolder, id: undefined, name: undefined }],
  ])("rejects %s with FolderUnavailableError", async (_case, file) => {
    const gateway = createDriveGateway(createFakeDriveClient({ file }));

    await expect(gateway.validateManagerFolder("folder-1")).rejects.toBeInstanceOf(
      FolderUnavailableError,
    );
  });

  it("rejects a missing folder without falling back to an all-Drive scan", async () => {
    const fakeDrive = createFakeDriveClient({
      getError: Object.assign(new Error("File not found"), { code: 404 }),
    });
    const gateway = createDriveGateway(fakeDrive);

    await expect(gateway.validateManagerFolder("folder-1")).rejects.toBeInstanceOf(
      FolderUnavailableError,
    );
    expect(fakeDrive.listCalls).toHaveLength(0);
  });
});

describe("listManagerFiles", () => {
  it("queries direct children only, follows pagination, and post-filters by name", async () => {
    const fakeDrive = createFakeDriveClient({
      listPages: [
        {
          files: [
            { id: "file-1", name: "202607勤怠管理表", ownedByMe: true },
            { id: "file-2", name: "202607 Expenses", ownedByMe: true },
          ],
          nextPageToken: "page-2",
        },
        {
          files: [
            { id: "file-3", name: "202608勤怠管理表", ownedByMe: false },
            { id: "file-4", name: "202608勤怠表", ownedByMe: true },
            {
              id: "file-5",
              name: "202608勤怠管理表",
              ownedByMe: true,
              owners: [{ emailAddress: "Manager@Blended-Asia.com" }],
              appProperties: { attendanceSetupState: "ready" },
            },
          ],
        },
      ],
    });
    const gateway = createDriveGateway(fakeDrive);

    const files = await gateway.listManagerFiles("folder-1");

    expect(fakeDrive.listCalls[0].q).toContain("'folder-1' in parents");
    expect(fakeDrive.listCalls[0].q).toContain("trashed = false");
    expect(fakeDrive.listCalls[0].q).toContain(`mimeType = '${SPREADSHEET_MIME_TYPE}'`);
    expect(fakeDrive.listCalls).toHaveLength(2); // nextPageToken was followed
    expect(fakeDrive.listCalls[1].pageToken).toBe("page-2");

    // file-3 is not owned by this account and is still listed: the folder's
    // contents are shown, and Google decides what may be done with them.
    expect(files.map((file) => file.id)).toEqual(["file-1", "file-3", "file-5"]);
    expect(files[2]).toEqual({
      id: "file-5",
      name: "202608勤怠管理表",
      ownedByMe: true,
      sharedWithMe: false,
      ownerEmail: "manager@blended-asia.com",
      appProperties: { attendanceSetupState: "ready" },
      modifiedTime: null,
    });
  });

  it("does not traverse descendant folders when the folder has no matching children", async () => {
    const fakeDrive = createFakeDriveClient({ listPages: [{ files: [] }] });
    const gateway = createDriveGateway(fakeDrive);

    await expect(gateway.listManagerFiles("folder-1")).resolves.toEqual([]);
    expect(fakeDrive.listCalls).toHaveLength(1);
  });
});

describe("listEmployeeCandidates", () => {
  it("scans the shared-with-me spreadsheet corpus and keeps the attendance name marker", async () => {
    const fakeDrive = createFakeDriveClient({
      listPages: [
        {
          files: [
            {
              id: "file-1",
              name: "202607勤怠管理表",
              sharedWithMeTime: "2026-07-01T00:00:00Z",
              owners: [{ emailAddress: "Manager@Blended-Asia.com" }],
            },
          ],
          nextPageToken: "page-2",
        },
        { files: [{ id: "file-2", name: "Team notes", sharedWithMeTime: "2026-07-01T00:00:00Z" }] },
      ],
    });
    const gateway = createDriveGateway(fakeDrive);

    const files = await gateway.listEmployeeCandidates();

    expect(fakeDrive.listCalls[0].q).toContain(`mimeType = '${SPREADSHEET_MIME_TYPE}'`);
    expect(fakeDrive.listCalls[0].q).toContain("trashed = false");
    expect(fakeDrive.listCalls[0].q).toContain("勤怠管理表");
    expect(fakeDrive.listCalls[0].q).not.toContain("sharedWithMe");
    expect(fakeDrive.listCalls).toHaveLength(2);

    expect(files).toEqual([
      {
        id: "file-1",
        name: "202607勤怠管理表",
        ownedByMe: false,
        sharedWithMe: true,
        ownerEmail: "manager@blended-asia.com",
        appProperties: {},
        modifiedTime: null,
      },
    ]);
  });
});

describe("getFileAccess", () => {
  it("returns normalized ownership, trashed state, and edit capability", async () => {
    const fakeDrive = createFakeDriveClient({
      file: {
        id: "file-1",
        name: "202607勤怠管理表",
        mimeType: SPREADSHEET_MIME_TYPE,
        trashed: false,
        ownedByMe: false,
        owners: [{ emailAddress: "Manager@Blended-Asia.com" }],
        appProperties: { attendanceApp: "v1" },
        capabilities: { canEdit: true },
      },
    });
    const gateway = createDriveGateway(fakeDrive);

    await expect(gateway.getFileAccess("file-1")).resolves.toEqual({
      id: "file-1",
      name: "202607勤怠管理表",
      mimeType: SPREADSHEET_MIME_TYPE,
      trashed: false,
      ownedByMe: false,
      ownerEmail: "manager@blended-asia.com",
      appProperties: { attendanceApp: "v1" },
      canEdit: true,
    });
  });
});

describe("createSpreadsheetFile", () => {
  it("creates a Google Sheets file directly in exactly one destination folder", async () => {
    const fakeDrive = createFakeDriveClient({
      createdFile: { id: "file-1", name: "202607勤怠管理表" },
    });
    const gateway = createDriveGateway(fakeDrive);

    await expect(
      gateway.createSpreadsheetFile({
        name: "202607勤怠管理表",
        folderId: "folder-1",
        appProperties: { attendanceApp: "v1" },
      }),
    ).resolves.toEqual({ id: "file-1", name: "202607勤怠管理表" });

    const [call] = fakeDrive.createCalls;
    expect(call.requestBody.mimeType).toBe(SPREADSHEET_MIME_TYPE);
    expect(call.requestBody.parents).toEqual(["folder-1"]);
    expect(call.requestBody.name).toBe("202607勤怠管理表");
    expect(call.requestBody.appProperties).toEqual({ attendanceApp: "v1" });
    expect(call.media).toBeUndefined();
  });
});

describe("convertXlsx", () => {
  it("uploads the original bytes as XLSX media while requesting Sheets conversion", async () => {
    const content = new Uint8Array([80, 75, 3, 4]);
    const fakeDrive = createFakeDriveClient({
      createdFile: { id: "file-1", name: "202607勤怠管理表" },
    });
    const gateway = createDriveGateway(fakeDrive);

    await expect(
      gateway.convertXlsx({
        name: "202607勤怠管理表",
        folderId: "folder-1",
        content,
        appProperties: { attendanceMonth: "2026-07" },
      }),
    ).resolves.toEqual({ id: "file-1", name: "202607勤怠管理表" });

    const [call] = fakeDrive.createCalls;
    expect(call.media?.mimeType).toBe(XLSX_MIME_TYPE);
    expect(call.media?.body).toBe(content);
    expect(call.requestBody.mimeType).toBe(SPREADSHEET_MIME_TYPE);
    expect(call.requestBody.name).toBe("202607勤怠管理表");
    expect(call.requestBody.parents).toHaveLength(1);
    expect(call.requestBody.parents).toEqual(["folder-1"]);
  });
});

describe("createWriterPermission", () => {
  it("sends a notification email and returns the created permission id", async () => {
    const fakeDrive = createFakeDriveClient({ permissionId: "permission-1" });
    const gateway = createDriveGateway(fakeDrive);

    await expect(
      gateway.createWriterPermission("file-1", "Employee@Blended-Asia.com"),
    ).resolves.toBe("permission-1");

    expect(fakeDrive.permissionCalls).toEqual([
      {
        fileId: "file-1",
        sendNotificationEmail: true,
        requestBody: {
          type: "user",
          role: "writer",
          emailAddress: "employee@blended-asia.com",
        },
        fields: "id",
      },
    ]);
  });

  it("records one Drive call per invitation so callers can serialize them", async () => {
    const fakeDrive = createFakeDriveClient();
    const gateway = createDriveGateway(fakeDrive);

    await gateway.createWriterPermission("file-1", "a@blended-asia.com");
    await gateway.createWriterPermission("file-1", "b@blended-asia.com");

    expect(fakeDrive.permissionCalls.map((call) => call.requestBody.emailAddress)).toEqual([
      "a@blended-asia.com",
      "b@blended-asia.com",
    ]);
  });
});

describe("updateAppProperties", () => {
  it("patches only the attendance app properties", async () => {
    const fakeDrive = createFakeDriveClient();
    const gateway = createDriveGateway(fakeDrive);

    await gateway.updateAppProperties("file-1", { attendanceSetupState: "ready" });

    expect(fakeDrive.updateCalls).toEqual([
      {
        fileId: "file-1",
        requestBody: { appProperties: { attendanceSetupState: "ready" } },
        fields: "id",
      },
    ]);
  });
});

describe("shared-with-me field selection (Drive v3 contract)", () => {
  it("does not request the non-existent `sharedWithMe` File field", () => {
    // Drive v3 File has `sharedWithMeTime`; `sharedWithMe` is a query-only term.
    // Requesting it makes files.list fail with 400 "Invalid field selection".
    expect(FILE_SUMMARY_FIELDS).not.toMatch(/\bsharedWithMe\b(?!Time)/);
    expect(FILE_SUMMARY_FIELDS).toContain("sharedWithMeTime");
  });

  it("derives sharedWithMe from the presence of sharedWithMeTime", async () => {
    const fakeDrive = createFakeDriveClient({
      listPages: [
        {
          files: [
            { id: "shared", name: "202607勤怠管理表", sharedWithMeTime: "2026-07-01T00:00:00Z" },
            { id: "own", name: "202608勤怠管理表" },
          ],
        },
      ],
    });
    const gateway = createDriveGateway(fakeDrive);

    const files = await gateway.listEmployeeCandidates();

    expect(fakeDrive.listCalls[0].fields).toBe(FILE_SUMMARY_FIELDS);
    expect(files.map((file) => [file.id, file.sharedWithMe])).toEqual([
      ["shared", true],
      ["own", false],
    ]);
  });
});

describe("shared drive visibility", () => {
  it("asks Drive to include shared-drive items in every listing", async () => {
    const fakeDrive = createFakeDriveClient({ listPages: [{ files: [] }] });
    const gateway = createDriveGateway(fakeDrive);

    await gateway.listEmployeeCandidates();
    await gateway.listManagerFiles("folder-1");

    // Without both flags Drive silently omits every shared-drive file.
    for (const call of fakeDrive.listCalls) {
      expect(call.supportsAllDrives).toBe(true);
      expect(call.includeItemsFromAllDrives).toBe(true);
    }
  });

  it("reads file access metadata for shared-drive files instead of 404ing", async () => {
    const fakeDrive = createFakeDriveClient({
      file: { id: "file-1", name: "202608勤怠管理表", mimeType: SPREADSHEET_MIME_TYPE },
    });
    const gateway = createDriveGateway(fakeDrive);

    await gateway.getFileAccess("file-1");

    // Google answers 404, not 403, when this flag is missing on a shared drive.
    expect(fakeDrive.getCalls.at(-1)?.supportsAllDrives).toBe(true);
  });
});
