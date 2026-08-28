// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import {
  buildAttendanceWorkbookBuffer,
  buildNonXlsxBuffer,
  buildOversizeBuffer,
} from "../../../../../../tests/fixtures/workbook";
import { MAX_WORKBOOK_BYTES } from "@/lib/workbook/xlsx-inspector";

const SECRET = "test-secret";
const COOKIE_NAME = "authjs.session-token";
const URL = "http://attendance.test/api/files/import/inspect";

const googleCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/google/client", () => ({
  createGoogleGateways: () => {
    googleCalls.count += 1;
    throw new Error("Inspection must not touch Google.");
  },
}));

const { POST } = await import("./route");

async function sessionCookie(): Promise<string> {
  const encrypted = await encode({
    secret: SECRET,
    salt: COOKIE_NAME,
    token: { email: "Manager@Blended-Asia.com", accessToken: "provider-token" },
  });

  return `${COOKIE_NAME}=${encodeURIComponent(encrypted)}`;
}

/** `File` accepts only `ArrayBuffer`-backed views, so the bytes are copied verbatim. */
function asBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

interface UploadOptions {
  bytes?: Uint8Array;
  filename?: string;
  /** Omit the `file` field entirely. */
  omitFile?: boolean;
  signedIn?: boolean;
  /** Streams the body so the request carries no `Content-Length`. */
  stream?: boolean;
}

async function uploadRequest(options: UploadOptions = {}): Promise<Request> {
  const form = new FormData();
  if (!options.omitFile) {
    const bytes = options.bytes ?? new Uint8Array();
    form.set("file", new File([asBlobPart(bytes)], options.filename ?? "202607.xlsx"));
  }

  const encoded = new Request(URL, { method: "POST", body: form });
  const headers = new Headers(encoded.headers);
  if (options.signedIn !== false) headers.set("cookie", await sessionCookie());

  const body = await encoded.arrayBuffer();
  if (!options.stream) {
    return new Request(URL, { method: "POST", headers, body });
  }

  headers.delete("content-length");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    },
  });

  return new Request(URL, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_URL", "");
  googleCalls.count = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/files/import/inspect", () => {
  it("returns the recognized sheet metadata without any Google call", async () => {
    const response = await POST(await uploadRequest({ bytes: await buildAttendanceWorkbookBuffer() }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      sheets: [
        { title: "Employee A", rowCount: 31, month: "2026-07" },
        { title: "Employee B", rowCount: 31, month: "2026-07" },
      ],
    });
    expect(googleCalls.count).toBe(0);
  });

  it("rejects an anonymous request before reading the upload", async () => {
    const response = await POST(
      await uploadRequest({ bytes: await buildAttendanceWorkbookBuffer(), signedIn: false }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("rejects a request with no file field", async () => {
    const response = await POST(await uploadRequest({ omitFile: true }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported-file" });
  });

  it("reports the failing sheet and check for an unsupported workbook", async () => {
    const response = await POST(
      await uploadRequest({ bytes: await buildAttendanceWorkbookBuffer({ mutation: "break-headers" }) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "missing-headers",
      sheetTitle: "Employee A",
    });
  });

  it("rejects a file that is not a workbook", async () => {
    const response = await POST(await uploadRequest({ bytes: buildNonXlsxBuffer() }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported-file" });
  });

  it("rejects an oversize upload from its Content-Length before buffering it", async () => {
    const response = await POST(
      await uploadRequest({ bytes: buildOversizeBuffer(MAX_WORKBOOK_BYTES) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "file-too-large" });
  });

  it("rejects an oversize upload that declares no Content-Length", async () => {
    const response = await POST(
      await uploadRequest({ bytes: buildOversizeBuffer(MAX_WORKBOOK_BYTES), stream: true }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "file-too-large" });
  });
});
