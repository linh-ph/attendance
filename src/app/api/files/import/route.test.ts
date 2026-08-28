// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import {
  DEFAULT_SHEET_TITLES,
  buildAttendanceWorkbookBuffer,
} from "../../../../../tests/fixtures/workbook";
import { createFileDependenciesFake } from "../../../../../tests/fakes/file-dependencies";
import type { ConvertXlsxInput, DriveGateway } from "@/lib/google/types";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const URL = "http://attendance.test/api/files/import";
const MANAGER_EMAIL = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";
const CONVERTED_FILE_ID = "converted-file-1";
const FOLDER = { id: "folder-1", name: "Attendance 2026" };

const gateways = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/google/client", () => ({
  createGoogleGateways: () => {
    if (gateways.current === null) {
      throw new Error("The route requested gateways before the test provided them.");
    }
    return gateways.current;
  },
}));

const { POST } = await import("./route");

/* -------------------------------------------------------------------------- */
/* Fake                                                                        */
/* -------------------------------------------------------------------------- */

type FileDependencies = ReturnType<typeof createFileDependenciesFake>;

interface ImportFake extends Omit<FileDependencies, "drive"> {
  drive: DriveGateway;
  uploads: ConvertXlsxInput[];
}

/** Drive converts an upload into a file that already holds the workbook's tabs. */
async function createImportFake(): Promise<ImportFake> {
  const base = createFileDependenciesFake({ fileId: CONVERTED_FILE_ID });

  const converted = await base.drive.createSpreadsheetFile({
    name: "202607勤怠管理表",
    folderId: FOLDER.id,
  });
  const initial = await base.sheets.getSpreadsheet(converted.id);
  await base.sheets.batchUpdate(converted.id, [
    ...DEFAULT_SHEET_TITLES.map((title) => ({ addSheet: { properties: { title } } })),
    ...initial.sheets.map((sheet) => ({ deleteSheet: { sheetId: sheet.sheetId } })),
  ]);

  base.clearEvents();
  base.addedSheetTitles.length = 0;
  base.deletedSheetIds.length = 0;
  base.createdFiles.length = 0;

  const uploads: ConvertXlsxInput[] = [];
  const drive: DriveGateway = {
    ...base.drive,
    async convertXlsx(input: ConvertXlsxInput) {
      uploads.push(input);
      return { id: converted.id, name: input.name };
    },
  };

  return { ...base, drive, uploads };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

const validFields: Record<string, string> = {
  fileName: "202607勤怠管理表",
  month: "2026-07",
  destinationFolder: JSON.stringify({ id: "folder-1", name: "Stale folder name" }),
  mappings: JSON.stringify([
    { sheetTitle: "Employee A", email: "Employee-A@Blended-Asia.com" },
    { sheetTitle: "Employee B", email: "employee-b@blended-asia.com" },
  ]),
};

/** `File` accepts only `ArrayBuffer`-backed views, so the bytes are copied verbatim. */
function asBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

interface SaveOptions {
  fields?: Record<string, string>;
  omitFile?: boolean;
  signedIn?: boolean;
  bytes?: Uint8Array;
}

async function saveRequest(options: SaveOptions = {}): Promise<Request> {
  const form = new FormData();
  if (!options.omitFile) {
    const bytes = options.bytes ?? (await buildAttendanceWorkbookBuffer());
    form.set("file", new File([asBlobPart(bytes)], "202607.xlsx"));
  }

  for (const [name, value] of Object.entries(options.fields ?? validFields)) {
    form.set(name, value);
  }

  const encoded = new Request(URL, { method: "POST", body: form });
  const headers = new Headers(encoded.headers);

  if (options.signedIn !== false) {
    const encrypted = await encode({
      secret: SECRET,
      salt: COOKIE_NAME,
      token: { email: "Manager@Blended-Asia.com", accessToken: "provider-token" },
    });
    headers.set("cookie", `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`);
  }

  return new Request(URL, { method: "POST", headers, body: await encoded.arrayBuffer() });
}

let fake: ImportFake;

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
  fake = await createImportFake();
  gateways.current = { drive: fake.drive, sheets: fake.sheets };
});

afterEach(() => {
  vi.unstubAllEnvs();
  gateways.current = null;
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("POST /api/files/import", () => {
  it("converts the workbook and answers 201 when setup completes", async () => {
    const response = await POST(await saveRequest());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      fileId: CONVERTED_FILE_ID,
      folder: FOLDER,
      setupState: "ready",
      retryable: false,
      members: [
        { email: EMPLOYEE_A, setupStatus: "ready" },
        { email: EMPLOYEE_B, setupStatus: "ready" },
      ],
    });
  });

  it("answers 207 with the retained file when an invitation fails", async () => {
    fake.failInvite(EMPLOYEE_B);

    const response = await POST(await saveRequest());

    expect(response.status).toBe(207);
    await expect(response.json()).resolves.toEqual({
      fileId: "converted-file-1",
      folder: { id: "folder-1", name: "Attendance 2026" },
      setupState: "needs-repair",
      retryable: true,
      members: [
        { email: "employee-a@blended-asia.com", setupStatus: "ready" },
        { email: "employee-b@blended-asia.com", setupStatus: "invite-failed" },
      ],
    });
    expect(fake.uploads).toHaveLength(1);
  });

  it("passes the original upload bytes to Drive unchanged", async () => {
    const bytes = await buildAttendanceWorkbookBuffer();

    await POST(await saveRequest({ bytes }));

    expect(fake.uploads).toHaveLength(1);
    expect(Buffer.from(fake.uploads[0].content)).toEqual(bytes);
    expect(fake.uploads[0].folderId).toBe(FOLDER.id);
    expect(fake.uploads[0].name).toBe("202607勤怠管理表");
  });

  it("uses the signed-in identity and ignores a client-supplied owner email", async () => {
    const response = await POST(
      await saveRequest({ fields: { ...validFields, ownerEmail: "attacker@example.com" } }),
    );

    expect(response.status).toBe(201);
    const { config } = await fake.config.read(CONVERTED_FILE_ID);
    expect(config.ownerEmail).toBe(MANAGER_EMAIL);
  });

  it("resumes a converted file without uploading the workbook again", async () => {
    fake.failInvite(EMPLOYEE_B);
    await POST(await saveRequest());

    fake.clearInviteFailures();
    const response = await POST(
      await saveRequest({ fields: { ...validFields, resumeFileId: CONVERTED_FILE_ID } }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      fileId: CONVERTED_FILE_ID,
      setupState: "ready",
      retryable: false,
    });
    expect(fake.uploads).toHaveLength(1);
  });

  it("rejects an anonymous request before touching Google", async () => {
    const response = await POST(await saveRequest({ signedIn: false }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
    expect(fake.events).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a month the workbook does not match and creates no Drive file", async () => {
    const response = await POST(
      await saveRequest({ fields: { ...validFields, month: "2026-08" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "month-mismatch",
      sheetTitle: "Employee A",
    });
    expect(fake.events).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects an output name that is not discoverable as an attendance file", async () => {
    const response = await POST(
      await saveRequest({ fields: { ...validFields, fileName: "July report" } }),
    );

    expect(response.status).toBe(400);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects duplicate employee emails before any Drive mutation", async () => {
    const response = await POST(
      await saveRequest({
        fields: {
          ...validFields,
          mappings: JSON.stringify([
            { sheetTitle: "Employee A", email: EMPLOYEE_A },
            { sheetTitle: "Employee B", email: EMPLOYEE_A },
          ]),
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "duplicate-member-email" });
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a mapping that leaves a recognized sheet unassigned", async () => {
    const response = await POST(
      await saveRequest({
        fields: {
          ...validFields,
          mappings: JSON.stringify([{ sheetTitle: "Employee A", email: EMPLOYEE_A }]),
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "sheet-mapping-mismatch" });
    expect(fake.uploads).toEqual([]);
  });

  it("rejects malformed JSON fields", async () => {
    const response = await POST(
      await saveRequest({ fields: { ...validFields, mappings: "not-json" } }),
    );

    expect(response.status).toBe(400);
    expect(fake.uploads).toEqual([]);
  });

  it("rejects a request with no uploaded workbook", async () => {
    const response = await POST(await saveRequest({ omitFile: true }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported-file" });
    expect(fake.uploads).toEqual([]);
  });
});
