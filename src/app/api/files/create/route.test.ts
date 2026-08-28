import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { createFileDependenciesFake } from "../../../../../tests/fakes/file-dependencies";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const URL = "http://attendance.test/api/files/create";
const MANAGER_EMAIL = "manager@blended-asia.com";
const EMPLOYEE_A = "employee-a@blended-asia.com";
const EMPLOYEE_B = "employee-b@blended-asia.com";

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

const validBody = {
  fileName: "202607勤怠管理表",
  month: "2026-07",
  destinationFolder: { id: "folder-1", name: "Stale folder name" },
  members: [
    { displayName: "Employee A", email: "Employee-A@Blended-Asia.com" },
    { displayName: "Employee B", email: "employee-b@blended-asia.com" },
  ],
};

let fake: ReturnType<typeof createFileDependenciesFake>;

function useFake(): ReturnType<typeof createFileDependenciesFake> {
  fake = createFileDependenciesFake();
  gateways.current = { drive: fake.drive, sheets: fake.sheets };
  return fake;
}

async function signedRequest(body: unknown, token?: Record<string, unknown>): Promise<Request> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (token) {
    const encrypted = await encode({ secret: SECRET, salt: COOKIE_NAME, token });
    headers.cookie = `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`;
  }

  return new Request(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

function managerRequest(body: unknown): Promise<Request> {
  return signedRequest(body, { email: "Manager@Blended-Asia.com", accessToken: "provider-token" });
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
  useFake();
});

afterEach(() => {
  vi.unstubAllEnvs();
  gateways.current = null;
});

describe("POST /api/files/create", () => {
  it("creates the monthly file and answers 201 when setup completes", async () => {
    const response = await POST(await managerRequest(validBody));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      file: {
        id: "file-1",
        name: "202607勤怠管理表",
        month: "2026-07",
        setupState: "ready",
        complete: true,
      },
      folder: { id: "folder-1", name: "Attendance 2026" },
      members: [
        {
          displayName: "Employee A",
          email: EMPLOYEE_A,
          sheetId: "1",
          sheetTitle: "Employee A",
          protectionId: "2",
          permissionId: "permission-1",
          setupStatus: "complete",
          error: null,
        },
        {
          displayName: "Employee B",
          email: EMPLOYEE_B,
          sheetId: "2",
          sheetTitle: "Employee B",
          protectionId: "3",
          permissionId: "permission-2",
          setupStatus: "complete",
          error: null,
        },
      ],
    });
  });

  it("answers 207 and retains file, folder, and member progress on a partial setup", async () => {
    fake.failInvite(EMPLOYEE_B);

    const response = await POST(await managerRequest(validBody));

    expect(response.status).toBe(207);
    const body = (await response.json()) as {
      file: { id: string; setupState: string; complete: boolean };
      folder: { id: string; name: string };
      members: Array<{ email: string; setupStatus: string; error: string | null }>;
    };

    expect(body.file).toMatchObject({ id: "file-1", setupState: "pending", complete: false });
    expect(body.folder).toEqual({ id: "folder-1", name: "Attendance 2026" });
    expect(body.members.map((member) => member.setupStatus)).toEqual([
      "complete",
      "invite-failed",
    ]);
    expect(body.members[1].error).toBeTruthy();
    expect(fake.createdFiles).toHaveLength(1);
  });

  it("uses the signed-in identity and ignores a client-supplied owner email", async () => {
    const response = await POST(
      await managerRequest({ ...validBody, ownerEmail: "attacker@example.com" }),
    );

    expect(response.status).toBe(201);

    const { config } = await fake.config.read("file-1");
    expect(config.ownerEmail).toBe(MANAGER_EMAIL);
    expect(fake.addedProtections[0].editors).toEqual([MANAGER_EMAIL]);
  });

  it("rejects an anonymous request before touching Google", async () => {
    const response = await POST(await signedRequest(validBody));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
    expect(fake.events).toEqual([]);
  });

  it("rejects a file name that is not discoverable as an attendance file", async () => {
    const response = await POST(await managerRequest({ ...validBody, fileName: "July report" }));

    expect(response.status).toBe(400);
    expect(fake.events).toEqual([]);
  });

  it("rejects a request with no members", async () => {
    const response = await POST(await managerRequest({ ...validBody, members: [] }));

    expect(response.status).toBe(400);
    expect(fake.events).toEqual([]);
  });

  it("rejects duplicate member emails before any Google mutation", async () => {
    const response = await POST(
      await managerRequest({
        ...validBody,
        members: [
          { displayName: "Employee A", email: EMPLOYEE_A },
          { displayName: "Employee A again", email: "Employee-A@Blended-Asia.com" },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(fake.events).toEqual([]);
    expect(fake.createdFiles).toEqual([]);
  });
});
