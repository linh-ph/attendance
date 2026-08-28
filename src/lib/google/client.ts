import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { createFakeGoogleGateways } from "@/lib/testing/fake-google-store";
import { resolveTestMode } from "@/lib/testing/runtime-guard";
import { createDriveGateway } from "./drive-gateway";
import { createSheetsGateway } from "./sheets-gateway";
import type {
  DriveClient,
  DriveCreateParams,
  DriveGateway,
  SheetsClient,
  SheetsGateway,
} from "./types";

/**
 * The only module that imports `googleapis`. Everything else depends on the
 * transport interfaces in `types.ts`, so gateways and services stay testable
 * with fakes and free of provider response types.
 */

export interface GoogleGateways {
  drive: DriveGateway;
  sheets: SheetsGateway;
}

function authorize(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/** Streams the unmodified upload bytes; metadata still asks Drive to convert. */
function toUploadParams(params: DriveCreateParams): drive_v3.Params$Resource$Files$Create {
  const { media, ...rest } = params;

  if (!media) {
    return rest;
  }

  return {
    ...rest,
    media: { mimeType: media.mimeType, body: Readable.from(Buffer.from(media.body)) },
  };
}

export function createDriveClient(accessToken: string): DriveClient {
  const drive = google.drive({ version: "v3", auth: authorize(accessToken) });

  return {
    files: {
      get: (params) => drive.files.get(params) as unknown as ReturnType<DriveClient["files"]["get"]>,
      list: (params) =>
        drive.files.list(params) as unknown as ReturnType<DriveClient["files"]["list"]>,
      create: (params) =>
        drive.files.create(toUploadParams(params)) as unknown as ReturnType<
          DriveClient["files"]["create"]
        >,
      update: (params) =>
        drive.files.update(params) as unknown as ReturnType<DriveClient["files"]["update"]>,
    },
    permissions: {
      create: (params) =>
        drive.permissions.create(params) as unknown as ReturnType<
          DriveClient["permissions"]["create"]
        >,
    },
  };
}

export function createSheetsClient(accessToken: string): SheetsClient {
  const sheets = google.sheets({ version: "v4", auth: authorize(accessToken) });

  return {
    spreadsheets: {
      get: (params) =>
        sheets.spreadsheets.get(params) as unknown as ReturnType<
          SheetsClient["spreadsheets"]["get"]
        >,
      batchUpdate: (params) =>
        sheets.spreadsheets.batchUpdate(params) as unknown as ReturnType<
          SheetsClient["spreadsheets"]["batchUpdate"]
        >,
      values: {
        batchGet: (params) =>
          sheets.spreadsheets.values.batchGet(params) as unknown as ReturnType<
            SheetsClient["spreadsheets"]["values"]["batchGet"]
          >,
        batchUpdate: (params) =>
          sheets.spreadsheets.values.batchUpdate(params) as unknown as ReturnType<
            SheetsClient["spreadsheets"]["values"]["batchUpdate"]
          >,
      },
    },
  };
}

/**
 * Builds the per-request gateways bound to one signed-in user's access token.
 *
 * The single non-production seam lives here, because this is the only place the
 * application decides where Drive and Sheets calls actually go. `resolveTestMode`
 * is consulted first and it *throws* when `E2E_TEST_MODE` is set under
 * `NODE_ENV=production`, so a production build can neither fall through to the
 * deterministic adapter nor be talked into it by an environment variable. With
 * the flag absent — every production deployment — the guard returns `false` and
 * the real `googleapis` gateways below are constructed exactly as before.
 */
export function createGoogleGateways(accessToken: string): GoogleGateways {
  if (resolveTestMode(process.env)) {
    return createFakeGoogleGateways(accessToken);
  }

  return {
    drive: createDriveGateway(createDriveClient(accessToken)),
    sheets: createSheetsGateway(createSheetsClient(accessToken)),
  };
}
