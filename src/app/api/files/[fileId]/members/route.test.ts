import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import * as route from "./route";
import { GET, PATCH, POST, type MemberRouteDependencies } from "./route";
import { ForbiddenError, NeedsSetupError } from "@/lib/access/policy";
import { MemberServiceError, type MemberService } from "@/lib/files/member-service";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const URL = "http://attendance.test/api/files/file-1/members";

const MANAGER = "manager@blended-asia.com";
const NEW_MEMBER = "new@blended-asia.com";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface ServiceCall {
  method: "listMembers" | "addMember" | "retryInvitation";
  input: Record<string, unknown>;
}

interface FakeService {
  service: MemberService;
  calls: ServiceCall[];
  tokens: string[];
  dependencies: MemberRouteDependencies;
}

function memberSummary(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "New Person",
    email: NEW_MEMBER,
    sheetId: "200",
    sheetTitle: "New Person",
    setupStatus: "ready",
    invitationSent: true,
    ...overrides,
  };
}

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
    listMembers: record("listMembers", async () => ({
      fileId: "file-1",
      month: "2026-07",
      members: [memberSummary()],
    })),
    addMember: record("addMember", async () => ({
      fileId: "file-1",
      member: memberSummary(),
      invitationFailed: false,
    })),
    retryInvitation: record("retryInvitation", async () => ({
      fileId: "file-1",
      member: memberSummary(),
      invitationFailed: false,
    })),
  } as unknown as MemberService;

  return {
    service,
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

function context(fileId = "file-1") {
  return { params: Promise.resolve({ fileId }) };
}

async function signedRequest(
  init: { method?: string; body?: unknown; token?: Record<string, unknown> } = {},
): Promise<Request> {
  const token = init.token ?? {
    email: "Manager@Blended-Asia.com",
    accessToken: "provider-access-token",
  };
  const encrypted = await encode({ secret: SECRET, salt: COOKIE_NAME, token });

  return new Request(URL, {
    method: init.method ?? "GET",
    headers: {
      cookie: `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
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
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("members route surface", () => {
  it("never exposes a member-removal or permission-revocation method", () => {
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
  });
});

describe("GET /api/files/[fileId]/members", () => {
  it("returns the configured members to the signed-in owner", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(await signedRequest(), context(), fake.dependencies);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      fileId: "file-1",
      month: "2026-07",
      members: [memberSummary()],
    });
    expect(fake.calls).toEqual([
      { method: "listMembers", input: { fileId: "file-1", actorEmail: MANAGER } },
    ]);
    expect(fake.tokens).toEqual(["provider-access-token"]);
  });

  it("rejects an anonymous request", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await GET(new Request(URL), context(), fake.dependencies);

    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("returns 403 when the signed-in user is not the current owner", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      listMembers: async () => {
        throw new ForbiddenError("actor-not-owner");
      },
    });

    const response = await GET(await signedRequest(), context(), fake.dependencies);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You do not have access to this attendance sheet.",
      code: "forbidden",
    });
  });

  it("returns 409 when the file has never been configured", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      listMembers: async () => {
        throw new NeedsSetupError("config-sheet-missing");
      },
    });

    const response = await GET(await signedRequest(), context(), fake.dependencies);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "needs-setup" });
  });
});

describe("POST /api/files/[fileId]/members", () => {
  it("uses the route file ID and the session owner, ignoring anything the client sends", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: {
          displayName: "  New Person  ",
          email: "  New@Blended-Asia.COM ",
          fileId: "attacker-file",
          actorEmail: "attacker@blended-asia.com",
          setupStatus: "ready",
        },
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      member: memberSummary(),
      invitationFailed: false,
    });
    expect(fake.calls).toEqual([
      {
        method: "addMember",
        input: {
          fileId: "file-1",
          actorEmail: MANAGER,
          displayName: "New Person",
          email: NEW_MEMBER,
        },
      },
    ]);
  });

  it("returns 207 and retains the created IDs when the invitation fails", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      addMember: async () => ({
        fileId: "file-1",
        member: memberSummary({ setupStatus: "invite-failed", invitationSent: false }),
        invitationFailed: true,
      }),
    });

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: { displayName: "New Person", email: NEW_MEMBER },
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(207);
    await expect(response.json()).resolves.toEqual({
      member: memberSummary({ setupStatus: "invite-failed", invitationSent: false }),
      invitationFailed: true,
    });
  });

  it("returns 409 for an email that is already a member", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      addMember: async () => {
        throw new MemberServiceError("member-exists", "This email is already a member of this file.");
      },
    });

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: { displayName: "New Person", email: NEW_MEMBER },
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This email is already a member of this file.",
      code: "member-exists",
    });
  });

  it("returns 409 for a display name that already has a sheet", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      addMember: async () => {
        throw new MemberServiceError(
          "sheet-title-conflict",
          "This file already has a sheet with that name.",
        );
      },
    });

    const response = await POST(
      await signedRequest({
        method: "POST",
        body: { displayName: "Linh", email: NEW_MEMBER },
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "sheet-title-conflict" });
  });

  it("returns 400 without calling Google when the body is not a valid member", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      await signedRequest({ method: "POST", body: { displayName: "", email: "nope" } }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-member" });
    expect(fake.calls).toEqual([]);
  });

  it("rejects an anonymous request before reading the body", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "New Person", email: NEW_MEMBER }),
      }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });
});

describe("PATCH /api/files/[fileId]/members", () => {
  it("retries the invitation for exactly one existing member", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await PATCH(
      await signedRequest({ method: "PATCH", body: { email: " New@Blended-Asia.com " } }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      member: memberSummary(),
      invitationFailed: false,
    });
    expect(fake.calls).toEqual([
      {
        method: "retryInvitation",
        input: { fileId: "file-1", actorEmail: MANAGER, email: NEW_MEMBER },
      },
    ]);
  });

  it("returns 207 when the retried invitation fails again", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      retryInvitation: async () => ({
        fileId: "file-1",
        member: memberSummary({ setupStatus: "invite-failed", invitationSent: false }),
        invitationFailed: true,
      }),
    });

    const response = await PATCH(
      await signedRequest({ method: "PATCH", body: { email: NEW_MEMBER } }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(207);
  });

  it("returns 404 for an email that is not a member", async () => {
    stubAuthEnv();
    const fake = createFakeService({
      retryInvitation: async () => {
        throw new MemberServiceError("member-not-found", "This email is not a member of this file.");
      },
    });

    const response = await PATCH(
      await signedRequest({ method: "PATCH", body: { email: NEW_MEMBER } }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "member-not-found" });
  });

  it("returns 400 for a missing email", async () => {
    stubAuthEnv();
    const fake = createFakeService();

    const response = await PATCH(
      await signedRequest({ method: "PATCH", body: {} }),
      context(),
      fake.dependencies,
    );

    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});
