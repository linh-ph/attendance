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
  FILE_PEOPLE_FIELDS,
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
  type DrivePerson,
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
    sharedWithMe: typeof file.sharedWithMeTime === "string" && file.sharedWithMeTime !== "",
    ownerEmail: ownerEmailOf(file),
    appProperties: file.appProperties ?? {},
    modifiedTime: file.modifiedTime ?? null,
  };
}

function assertWritableManagerFolder(folder: DriveFileResource): DriveFolder {
  if (folder.mimeType !== FOLDER_MIME_TYPE) throw new FolderUnavailableError("not-a-folder");
  if (folder.trashed === true) throw new FolderUnavailableError("trashed");
  // Ownership is deliberately not required. Shared Drive files belong to the
  // organization and have no owner, and the app is a client over Google's own
  // sharing rather than an authorization layer of its own. What still matters
  // is whether this folder can actually receive a new monthly file.
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
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
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
          .filter((file) => hasAttendanceName(file.name))
          .map(toFileSummary)
          .filter((summary): summary is AttendanceFileSummary => summary !== null);
      } catch (error) {
        throw normalizeGoogleError(error, "files.list folder children");
      }
    },

    /**
     * Every attendance spreadsheet this account can reach, wherever it lives.
     *
     * `sharedWithMe = true` used to scope this, but it is false for every
     * shared-drive file, so organization-owned months were invisible. Access is
     * decided by Drive: if the query returns a file, the account can open it.
     */
    async listEmployeeCandidates() {
      const query = [
        `mimeType = '${SPREADSHEET_MIME_TYPE}'`,
        "trashed = false",
        `name contains '${ATTENDANCE_NAME_MARKER}'`,
      ].join(" and ");

      try {
        const files = await listAllPages(query);

        return files
          .filter((file) => hasAttendanceName(file.name))
          .map(toFileSummary)
          .filter((summary): summary is AttendanceFileSummary => summary !== null);
      } catch (error) {
        throw normalizeGoogleError(error, "files.list accessible candidates");
      }
    },

    async getFileAccess(fileId): Promise<DriveFileAccess> {
      try {
        const { data } = await drive.files.get({
          fileId,
          fields: FILE_ACCESS_FIELDS,
          supportsAllDrives: true,
        });

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

    /**
     * Everyone Drive says can reach this file.
     *
     * Only `user` grants become people: `anyone` and `domain` name nobody, and
     * a `group` address is a mailing list that cannot own a timesheet tab. An
     * account that may open a file but not see its sharing gets an empty list
     * back from Drive, which is an answer, not a failure — the caller treats it
     * as "nothing to offer" rather than an error.
     */
    async listPeople(fileId): Promise<DrivePerson[]> {
      try {
        const people: DrivePerson[] = [];
        let pageToken: string | undefined;

        do {
          const { data } = await drive.permissions.list({
            fileId,
            fields: FILE_PEOPLE_FIELDS,
            pageSize: DRIVE_PAGE_SIZE,
            pageToken,
            supportsAllDrives: true,
          });

          for (const permission of data.permissions ?? []) {
            if (permission.type !== "user") continue;

            const email = normalizeEmail(permission.emailAddress);
            if (email === null) continue;

            const displayName = permission.displayName?.trim();

            people.push({
              email,
              role: permission.role ?? "",
              displayName: displayName === undefined || displayName === "" ? null : displayName,
            });
          }

          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken !== undefined);

        return people;
      } catch (error) {
        throw normalizeGoogleError(error, "permissions.list");
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

    async createWriterPermission(fileId, email, notify) {
      try {
        const { data } = await drive.permissions.create({
          fileId,
          sendNotificationEmail: notify,
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
