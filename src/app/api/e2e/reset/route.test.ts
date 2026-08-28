import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireGoogleSessionFromRequest } from "@/lib/auth/session";
import {
  E2E_FIXTURE,
  getFakeGoogleStore,
  toTestAccessToken,
} from "@/lib/testing/fake-google-store";
import { POST } from "./route";

/**
 * The reset route is a security boundary before it is a convenience.
 *
 * Every refusal must be indistinguishable from "this route does not exist", and
 * a refused request must not touch the store, so a probe learns nothing from
 * either the status or a later observable state change.
 */

const SECRET = "local-vitest-only";
const RESET_URL = "http://127.0.0.1:3100/api/e2e/reset";

function resetRequest(init: { secret?: string; body?: unknown } = {}): Request {
  return new Request(RESET_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.secret === undefined ? {} : { "X-E2E-Secret": init.secret }),
    },
    body: JSON.stringify(init.body ?? {}),
  });
}

function enableTestMode(): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("E2E_TEST_MODE", "1");
  vi.stubEnv("E2E_TEST_SECRET", SECRET);
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret");
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3100");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/e2e/reset when test mode is off", () => {
  it("answers 404 with no body in production without the flag", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_TEST_SECRET", SECRET);

    const response = await POST(resetRequest({ secret: SECRET }));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers 404 — never 500 — when the flag is set in production, and says so in the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_TEST_MODE", "1");
    vi.stubEnv("E2E_TEST_SECRET", SECRET);

    const response = await POST(resetRequest({ secret: SECRET }));

    expect(response.status).toBe(404);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("E2E_TEST_MODE is forbidden in production"),
    );
  });

  it("answers 404 in a non-production environment that never opted in", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_TEST_SECRET", SECRET);

    expect((await POST(resetRequest({ secret: SECRET }))).status).toBe(404);
  });

  it("leaves the store untouched when it refuses", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const store = getFakeGoogleStore();
    store.files.delete(E2E_FIXTURE.readyFile.id);

    expect((await POST(resetRequest({ secret: SECRET }))).status).toBe(404);
    expect(getFakeGoogleStore().files.has(E2E_FIXTURE.readyFile.id)).toBe(false);
  });
});

describe("POST /api/e2e/reset secret", () => {
  beforeEach(enableTestMode);

  it("answers 404 when the request sends no secret", async () => {
    expect((await POST(resetRequest())).status).toBe(404);
  });

  it("answers 404 for a wrong secret", async () => {
    expect((await POST(resetRequest({ secret: "guess" }))).status).toBe(404);
    // Same length, different case: a prefix or length-only comparison would pass.
    expect((await POST(resetRequest({ secret: SECRET.toUpperCase() }))).status).toBe(404);
    expect((await POST(resetRequest({ secret: SECRET.slice(0, -1) }))).status).toBe(404);
  });

  it("answers 404 when the server itself has no secret configured", async () => {
    vi.stubEnv("E2E_TEST_SECRET", "");

    expect((await POST(resetRequest({ secret: "" }))).status).toBe(404);
  });

  it("does not reseed for a refused secret", async () => {
    const store = getFakeGoogleStore();
    store.files.delete(E2E_FIXTURE.readyFile.id);

    expect((await POST(resetRequest({ secret: "guess" }))).status).toBe(404);
    expect(getFakeGoogleStore().files.has(E2E_FIXTURE.readyFile.id)).toBe(false);
  });
});

describe("POST /api/e2e/reset with the shared secret", () => {
  beforeEach(enableTestMode);

  it("seeds owned folders, shared files, and configurations", async () => {
    getFakeGoogleStore().files.clear();

    const response = await POST(resetRequest({ secret: SECRET }));
    expect(response.status).toBe(200);

    const store = getFakeGoogleStore();
    expect([...store.folders.keys()]).toContain(E2E_FIXTURE.activeFolder.id);

    const ready = store.files.get(E2E_FIXTURE.readyFile.id);
    expect(ready?.ownerEmail).toBe(E2E_FIXTURE.managerEmail);
    expect(ready?.sharedWith.has(E2E_FIXTURE.employeeEmail)).toBe(true);
    expect(ready?.sheets.map((sheet) => sheet.title)).toEqual([
      "__APP_CONFIG",
      E2E_FIXTURE.employeeSheetTitle,
      E2E_FIXTURE.teammateSheetTitle,
    ]);

    // The legacy file is the `Needs setup` case: matching name, no config tab.
    const legacy = store.files.get(E2E_FIXTURE.legacyFile.id);
    expect(legacy?.sheets.some((sheet) => sheet.title === "__APP_CONFIG")).toBe(false);
  });

  it("returns the fixture identifiers the browser tests assert against", async () => {
    const body = (await (await POST(resetRequest({ secret: SECRET }))).json()) as {
      signedInAs: string | null;
      fixture: typeof E2E_FIXTURE;
    };

    expect(body.signedInAs).toBeNull();
    expect(body.fixture.activeFolder.id).toBe(E2E_FIXTURE.activeFolder.id);
  });

  it("records the requested fault injections", async () => {
    await POST(
      resetRequest({
        secret: SECRET,
        body: { attendanceSaveFailures: 1, inviteFailures: [E2E_FIXTURE.teammateEmail] },
      }),
    );

    const { faults } = getFakeGoogleStore();
    expect(faults.attendanceSaveFailures).toBe(1);
    expect(faults.inviteFailures.has(E2E_FIXTURE.teammateEmail)).toBe(true);
  });

  it("mints a real Auth.js session the committed session reader accepts", async () => {
    const response = await POST(
      resetRequest({ secret: SECRET, body: { signInAs: "Manager@Blended-Asia.com" } }),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { signedInAs: string }).signedInAs).toBe(
      E2E_FIXTURE.managerEmail,
    );

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((value) => value.startsWith("e2e-user="))).toBe(true);

    const sessionCookie = cookies.find((value) => value.startsWith("authjs.session-token="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).not.toContain("Secure");

    const cookieHeader = (sessionCookie as string).split(";")[0];

    await expect(
      requireGoogleSessionFromRequest(
        new Request("http://127.0.0.1:3100/api/dashboard", {
          headers: { cookie: cookieHeader },
        }),
      ),
    ).resolves.toEqual({
      email: E2E_FIXTURE.managerEmail,
      accessToken: toTestAccessToken(E2E_FIXTURE.managerEmail),
    });
  });

  it("signs in nobody when the body carries no user", async () => {
    const response = await POST(resetRequest({ secret: SECRET }));

    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
