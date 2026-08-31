import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncTransportError } from "./calendar-sync";
import { createSyncTransport } from "./sync-transport";

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function kindOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    if (error instanceof SyncTransportError) return error.kind;
    return `unexpected: ${String(error)}`;
  }

  return "no-error";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sync transport", () => {
  it("returns the discovered files and the ones that could not be read", async () => {
    respondWith(200, {
      timesheets: [{ id: "file-1" }],
      unreadable: [{ id: "file-9", name: "202607勤怠管理表" }],
    });

    const result = await createSyncTransport().discover();

    expect(result.timesheets).toHaveLength(1);
    expect(result.unreadable).toEqual([{ id: "file-9", name: "202607勤怠管理表" }]);
  });

  it("claims nothing failed when the server did not report unreadable files", async () => {
    respondWith(200, { timesheets: [] });

    expect((await createSyncTransport().discover()).unreadable).toEqual([]);
  });

  it("calls a request that never reached the server Offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    expect(await kindOf(() => createSyncTransport().discover())).toBe("offline");
  });

  it("maps an expired session, a file refusal, and a provider fault apart", async () => {
    respondWith(401, { error: "Sign in again." });
    expect(await kindOf(() => createSyncTransport().discover())).toBe("authentication");

    respondWith(403, { error: "Not yours." });
    expect(await kindOf(() => createSyncTransport().readMonth("file-1", "101"))).toBe("forbidden");

    respondWith(422, { error: "Needs repair." });
    expect(await kindOf(() => createSyncTransport().readMonth("file-1", "101"))).toBe("forbidden");

    // A disabled Sheets API arrives as this, and must never look like an
    // empty result.
    respondWith(502, { error: "Google Sheets could not be reached. Try again." });
    expect(await kindOf(() => createSyncTransport().readMonth("file-1", "101"))).toBe("provider");
  });

  it("addresses the attendance route with encoded identifiers", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );

    await createSyncTransport().readMonth("file/1", "1 01");

    expect(seen).toEqual(["/api/files/file%2F1/attendance/1%2001"]);
  });
});
