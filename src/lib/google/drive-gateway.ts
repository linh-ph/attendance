import {
  FolderUnavailableError,
  isMissingOrForbidden,
  normalizeGoogleError,
} from "./errors";
import {
  ATTENDANCE_NAME_MARKER,
  CREATED_FILE_FIELDS,
  DRIVE_PAGE_SIZE,
  FILE_ACCESS_FIELDS,
  FILE_SUMMARY_FIELDS,
  FOLDER_METADATA_FIELDS,
  FOLDER_MIME_TYPE,
  SPREADSHEET_MIME_TYPE,
  XLSX_MIME_TYPE,
  type AttendanceFileSummary,
  type ConvertXlsxInput,
  type CreateDriveSpreadsheetInput,
  type CreatedDriveFile,
  type DriveClient,
  type DriveFileAccess,
  type DriveFileResource,
  type DriveFolder,
  type DriveGateway,
} from "./types";

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function ownerEmailOf(file: DriveFileResource): string | null {
  return normalizeEmail(file.owners?.[0]?.emailAddress);
}

function hasAttendanceName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.includes(ATTENDANCE_NAME_MARKER);
}

function toFileSummary(file: DriveFileResource): AttendanceFileSummary | null {
  if (!file.id || !file.name) {
    return null;
  }

  return {
    id: file.id,
    name: file.name,
    ownedByMe: file.ownedByMe === true,
    sharedWithMe: file.sharedWithMe === true,
    ownerEmail: ownerEmailOf(file),
    appProperties: file.appProperties ?? {},
    modifiedTime: file.modifiedTime ?? null,
  };
}

function assertWritableManagerFolder(folder: DriveFileResource): DriveFolder {
  if (folder.mimeType !== FOLDER_MIME_TYPE) throw new FolderUnavailableError("not-a-folder");
  if (folder.trashed === true) throw new FolderUnavailableError("trashed");
  if (folder.ownedByMe !== true) throw new FolderUnavailableError("not-owned");
  if (folder.driveId) throw new FolderUnavailableError("shared-drive");
  if (folder.capabilities?.canAddChildren !== true) {
    throw new FolderUnavailableError("not-writable");
  }
  if (!folder.id || !folder.name) throw new FolderUnavailableError("incomplete-metadata");

  return { id: folder.id, name: folder.name };
}

function toCreatedFile(file: DriveFileResource, fallbackName: string): CreatedDriveFile {
  if (!file.id) {
    throw normalizeGoogleError(new Error("Drive returned no file id."), "files.create");
  }

  return { id: file.id, name: file.name ?? fallbackName };
}

export function createDriveGateway(drive: DriveClient): DriveGateway {
  async function listAllPages(query: string): Promise<DriveFileResource[]> {
    const files: DriveFileResource[] = [];
    let pageToken: string | undefined;

    do {
      const { data } = await drive.files.list({
        q: query,
        fields: FILE_SUMMARY_FIELDS,
        pageSize: DRIVE_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });

      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    return files;
  }

  return {
    async validateManagerFolder(folderId) {
      let folder: DriveFileResource;

      try {
        const { data } = await drive.files.get({
          fileId: folderId,
          fields: FOLDER_METADATA_FIELDS,
          supportsAllDrives: true,
        });
        folder = data;
      } catch (error) {
        if (isMissingOrForbidden(error)) {
          throw new FolderUnavailableError("not-found", { cause: error });
        }
        throw normalizeGoogleError(error, "files.get folder");
      }

      return assertWritableManagerFolder(folder);
    },

    async listManagerFiles(folderId) {
      const query = [
        `'${escapeQueryValue(folderId)}' in parents`,
        `mimeType = '${SPREADSHEET_MIME_TYPE}'`,
        "trashed = false",
      ].join(" and ");

      try {
        const files = await listAllPages(query);

        return files
          .filter((file) => file.ownedByMe === true && hasAttendanceName(file.name))
          .map(toFileSummary)
          .filter((summary): summary is AttendanceFileSummary => summary !== null);
      } catch (error) {
        throw normalizeGoogleError(error, "files.list folder children");
      }
    },

    async listEmployeeCandidates() {
      const query = [
        `mimeType = '${SPREADSHEET_MIME_TYPE}'`,
        "trashed = false",
        "sharedWithMe = true",
      ].join(" and ");

      try {
        const files = await listAllPages(query);

        return files
          .filter((file) => hasAttendanceName(file.name))
          .map(toFileSummary)
          .filter((summary): summary is AttendanceFileSummary => summary !== null);
      } catch (error) {
        throw normalizeGoogleError(error, "files.list shared candidates");
      }
    },

    async getFileAccess(fileId): Promise<DriveFileAccess> {
      try {
        const { data } = await drive.files.get({ fileId, fields: FILE_ACCESS_FIELDS });

        return {
          id: data.id ?? fileId,
          name: data.name ?? "",
          mimeType: data.mimeType ?? "",
          trashed: data.trashed === true,
          ownedByMe: data.ownedByMe === true,
          ownerEmail: ownerEmailOf(data),
          appProperties: data.appProperties ?? {},
          canEdit: data.capabilities?.canEdit === true,
        };
      } catch (error) {
        throw normalizeGoogleError(error, "files.get access");
      }
    },

    async createSpreadsheetFile(input: CreateDriveSpreadsheetInput) {
      try {
        const { data } = await drive.files.create({
          requestBody: {
            name: input.name,
            mimeType: SPREADSHEET_MIME_TYPE,
            parents: [input.folderId],
            ...(input.appProperties ? { appProperties: input.appProperties } : {}),
          },
          fields: CREATED_FILE_FIELDS,
        });

        return toCreatedFile(data, input.name);
      } catch (error) {
        throw normalizeGoogleError(error, "files.create spreadsheet");
      }
    },

    async convertXlsx(input: ConvertXlsxInput) {
      try {
        const { data } = await drive.files.create({
          requestBody: {
            name: input.name,
            mimeType: SPREADSHEET_MIME_TYPE,
            parents: [input.folderId],
            ...(input.appProperties ? { appProperties: input.appProperties } : {}),
          },
          media: { mimeType: XLSX_MIME_TYPE, body: input.content },
          fields: CREATED_FILE_FIELDS,
        });

        return toCreatedFile(data, input.name);
      } catch (error) {
        throw normalizeGoogleError(error, "files.create xlsx conversion");
      }
    },

    async createWriterPermission(fileId, email) {
      try {
        const { data } = await drive.permissions.create({
          fileId,
          sendNotificationEmail: true,
          requestBody: {
            type: "user",
            role: "writer",
            emailAddress: normalizeEmail(email) ?? email,
          },
          fields: "id",
        });

        if (!data.id) {
          throw new Error("Drive returned no permission id.");
        }

        return data.id;
      } catch (error) {
        throw normalizeGoogleError(error, "permissions.create");
      }
    },

    async updateAppProperties(fileId, properties) {
      try {
        await drive.files.update({
          fileId,
          requestBody: { appProperties: properties },
          fields: "id",
        });
      } catch (error) {
        throw normalizeGoogleError(error, "files.update appProperties");
      }
    },
  };
}
