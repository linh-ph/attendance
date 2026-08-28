import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { GET, POST, type SetupRouteDependencies } from "./route";
import { ForbiddenError } from "@/lib/access/policy";
import {
  LegacySetupError,
  type ExistingFileInspection,
  type MonthlySetupResult,
  type SetupService,
} from "@/lib/files/setup-service";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const BASE_URL = "http://attendance.test/api/files/legacy-file/setup";

const FILE_ID = "legacy-file";
const MANAGER = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";
const FOLDER = { id: "folder-1", name: "Attendance 2026" };

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface ServiceCall {
  method: "inspectExisting" | "configureExisting";
  input: Record<string, unknown>;
}

interface FakeService {
  calls: ServiceCall[];
  tokens: string[];
  dependencies: SetupRouteDependencies;
}

function memberProgress(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Employee A",
    email: EMPLOYEE_A,
    sheetId: "11",
    sheetTitle: "従業員A",
    protectionId: "2",
    permissionId: "permission-1",
    setupStatus: "ready",
    error: null,
    ...overrides,
  };
}

const inspection: ExistingFileInspection = {
  fileId: FILE_ID,
  fileName: "202607勤怠管理表",
  folder: FOLDER,
  month: null,
  sheets: [
    { sheetId: "11", title: "従業員A" },
    { sheetId: "12", title: "従業員B" },
  ],
  hasUntrustedConfig: true,
  members: [],
};

const configured = {
  fileId: FILE_ID,
  fileName: "202607勤怠管理表",
  month: "2026-07",
  folder: FOLDER,
  setupState: "ready",
  complete: true,
  members: [memberProgress()],
} as unknown as MonthlySetupResult;

function createFakeService(
  behavior: Partial<Record<ServiceCall["method"], () => Promise<unknown>>> = {},
): FakeService {
  const calls: ServiceCall[] = [];
  const tokens: string[] = [];

  const record = (method: ServiceCall["method"], fallback: () => Promise<unknown>) => {
    return async (input: Record<string, unknown>) => {
      calls.push({ method, input });
      return (behavior[method] ?? fallback)();
    };
  };

  const service = {
    inspectExisting: record("inspectExisting", async () => inspection),
    configureExisting: record("configureExisting", async () => configured),
  } as unknown as SetupService;

  return {
    calls,
    tokens,
    dependencies: {
      async createService(accessToken: string) {
        tokens.push(accessToken);
        return service;
      },
    },
  };
}

function context(fileId = FILE_ID) {
  return { params: Promise.resolve({ fileId }) };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    pickedFileId: FILE_ID,
    folderId: FOLDER.id,
    month: "2026-07",
    mappings: [
      { sheetId: "11", displayName: "Employee A", email: "Employee-A@Blended-Asia.com" },
      { sheetId: "12", displayName: "Employee B", email: EMPLOYEE_B },
    ],
    ...overrides,
  };
}

async function signedRequest(
  init: { method?: string; body?: unknown; query?: string; token?: Record<string, unknown> | null } = {},
): Promise<Request> {
  const url = init.query === undefined ? BASE_URL : `${BASE_URL}?${init.query}`;
  const headers: Record<string, string> = {};

  if (init.token !== null) {
    const token = init.token ?? { email: "Manager@Blended-Asia.com", accessToken: "provider-access-token" };
    const encrypted = await encode({ secret: SECRET, salt: COOKIE_NAME, token });
    headers.cookie = `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`;
  }

  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function stubAuthEnv(): void {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

describe("GET /api/files/[fileId]/setup", () => {
  it("requires an authenticated session", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(
      await signedRequest({ query: `folderId=${FOLDER.id}&pickedFileId=${FILE_ID}`, token: null }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("refuses to read the file until the picker confirms this same file", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(
      await signedRequest({ query: `folderId=${FOLDER.id}&pickedFileId=another-file` }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "picker-file-mismatch" });
    expect(fake.calls).toEqual([]);
  });

  it("returns the file's employee sheets for the verified session identity", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(
      await signedRequest({ query: `folderId=${FOLDER.id}&pickedFileId=${FILE_ID}` }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      file: { id: FILE_ID, name: "202607勤怠管理表", month: null },
      folder: FOLDER,
      sheets: inspection.sheets,
      hasUntrustedConfig: true,
      members: [],
    });

    expect(fake.calls).toEqual([
      {
        method: "inspectExisting",
        input: { ownerEmail: MANAGER, fileId: FILE_ID, folderId: FOLDER.id },
      },
    ]);
    expect(fake.tokens).toEqual(["provider-access-token"]);
  });

  it("requires the manager's active folder", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(
      await signedRequest({ query: `pickedFileId=${FILE_ID}` }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/files/[fileId]/setup", () => {
  it("requires an authenticated session", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody(), token: null }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("mutates nothing when the picked file is not the route file", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody({ pickedFileId: "another-file" }) }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "picker-file-mismatch" });
    expect(fake.calls).toEqual([]);
  });

  it("rejects a request without one mapping per sheet before calling Google", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody({ mappings: [] }) }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("configures the file with the verified session identity, ignoring a client owner", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: validBody({ ownerEmail: "intruder@blended-asia.com", fileId: "other-file" }),
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      file: {
        id: FILE_ID,
        name: "202607勤怠管理表",
        month: "2026-07",
        setupState: "ready",
        complete: true,
      },
      folder: FOLDER,
      members: [memberProgress()],
    });

    expect(fake.calls).toEqual([
      {
        method: "configureExisting",
        input: {
          ownerEmail: MANAGER,
          fileId: FILE_ID,
          folderId: FOLDER.id,
          month: "2026-07",
          mappings: [
            { sheetId: "11", displayName: "Employee A", email: EMPLOYEE_A },
            { sheetId: "12", displayName: "Employee B", email: EMPLOYEE_B },
          ],
        },
      },
    ]);
  });

  it("answers 207 and retains member progress when an invitation fails", async () => {
    stubAuthEnv();
    const partial = {
      ...configured,
      setupState: "pending",
      complete: false,
      members: [
        memberProgress(),
        memberProgress({
          displayName: "Employee B",
          email: EMPLOYEE_B,
          sheetId: "12",
          sheetTitle: "従業員B",
          protectionId: "3",
          permissionId: null,
          setupStatus: "invite-failed",
          error: "Could not share this file with this member.",
        }),
      ],
    } as unknown as MonthlySetupResult;

    const fake = createFakeService({ configureExisting: async () => partial });

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody() }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(207);
    const body = (await response.json()) as { members: { setupStatus: string }[] };
    expect(body.members.map((member) => member.setupStatus)).toEqual(["ready", "invite-failed"]);
  });

  it("answers 400 when the same member or sheet is mapped twice", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      configureExisting: async () => {
        throw new LegacySetupError(
          "duplicate-member-email",
          'Member email "employee-a@blended-asia.com" is listed more than once.',
        );
      },
    });

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: validBody({
          mappings: [
            { sheetId: "11", displayName: "Employee A", email: EMPLOYEE_A },
            { sheetId: "12", displayName: "Employee A", email: EMPLOYEE_A },
          ],
        }),
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "duplicate-member-email" });
  });

  it("answers 422 when a mapped sheet is missing from the file", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      configureExisting: async () => {
        throw new LegacySetupError("member-sheet-missing", "The sheet is missing from this file.");
      },
    });

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody() }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(422);
  });

  it("answers 403 when the signed-in manager no longer owns the file", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      configureExisting: async () => {
        throw new ForbiddenError("actor-not-owner");
      },
    });

    const response = await POST(
      await signedRequest({ method: "POST", body: validBody() }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain("actor-not-owner");
  });
});
