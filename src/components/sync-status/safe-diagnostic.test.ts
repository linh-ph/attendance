import { describe, expect, it } from "vitest";
import { MAX_DEBUG_FIELD_LENGTH, toSafeDiagnostic } from "./safe-diagnostic";

/**
 * The representative secrets spec §11.3 requires, in the four shapes it names.
 * They are declared once and reused, so a new redaction rule cannot quietly
 * stop covering one of them.
 */
const SECRETS = {
  accessToken: "ya29.a0AfB_bQm7SECRETACCESSTOKENvalue1234",
  refreshToken: "1//04SECRETREFRESHTOKENvalue5678",
  clientSecret: "GOCSPX-SECRETclientSECRETvalue90",
  apiKey: "AIzaSySECRETapiKEYvalue1234567890abc",
  sessionCookie: "authjs.session-token=SECRETcookieVALUE0987654321",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRUNSRVQifQ.c2lnbmF0dXJlU0VDUkVU",
  basic: "ZGV2LWNsaWVudDpHT0NTUFgtU0VDUkVUdmFsdWU=",
  opaque: "c2VjcmV0LXBheWxvYWQtdmFsdWUtdGhhdC1pcy1sb25n",
} as const;

/** Every raw secret value, so a test can assert none of them survives. */
const SECRET_VALUES: readonly string[] = Object.values(SECRETS);

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    name: "GoogleApiError",
    message: "Google request failed: files.list.",
    status: 403,
    providerMessage: null,
    providerStatus: null,
    providerReason: null,
    ...overrides,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value ?? {});
}

describe("toSafeDiagnostic — envelope narrowing", () => {
  it("keeps exactly the six allowlisted fields", () => {
    const safe = toSafeDiagnostic(envelope({ requestId: "7fd2", config: { retries: 3 } }));

    expect(Object.keys(safe ?? {}).sort()).toEqual([
      "message",
      "name",
      "providerMessage",
      "providerReason",
      "providerStatus",
      "status",
    ]);
  });

  it("drops every unknown provider field the server might ever add", () => {
    const safe = toSafeDiagnostic(
      envelope({
        requestId: "7fd2-1234",
        url: "https://www.googleapis.com/drive/v3/files?access_token=leaked",
        headers: { authorization: `Bearer ${SECRETS.accessToken}` },
        body: { refresh_token: SECRETS.refreshToken },
        stack: "GoogleApiError: boom\n    at drive-gateway.ts:42",
        errors: [{ reason: "forbidden", domain: "global" }],
      }),
    );

    const text = serialized(safe);
    expect(text).not.toContain("requestId");
    expect(text).not.toContain("headers");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("drive-gateway.ts");
    expect(text).not.toContain("googleapis.com/drive");
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it("returns null for anything that is not an envelope at all", () => {
    expect(toSafeDiagnostic(undefined)).toBeNull();
    expect(toSafeDiagnostic(null)).toBeNull();
    expect(toSafeDiagnostic("boom")).toBeNull();
    expect(toSafeDiagnostic(new Error("boom"))).toBeNull();
    expect(toSafeDiagnostic({})).toBeNull();
  });

  it("keeps status numeric or null and never coerces a string into one", () => {
    expect(toSafeDiagnostic(envelope({ status: 502 }))?.status).toBe(502);
    expect(toSafeDiagnostic(envelope({ status: "502" }))?.status).toBeNull();
    expect(toSafeDiagnostic(envelope({ status: Number.NaN }))?.status).toBeNull();
    expect(toSafeDiagnostic(envelope({ status: null }))?.status).toBeNull();
  });

  it("caps each string independently rather than the envelope as a whole", () => {
    // Ordinary prose, so the cap is what truncates it and not a redaction rule.
    const long = "the caller does not have permission. ".repeat(200);
    const safe = toSafeDiagnostic(envelope({ message: long, providerMessage: long }));

    expect(long.length).toBeGreaterThan(MAX_DEBUG_FIELD_LENGTH);
    expect(safe?.message?.length).toBeLessThanOrEqual(MAX_DEBUG_FIELD_LENGTH + 1);
    expect(safe?.providerMessage?.length).toBeLessThanOrEqual(MAX_DEBUG_FIELD_LENGTH + 1);
  });
});

describe("toSafeDiagnostic — redaction, all four representative shapes", () => {
  it("redacts labeled credentials", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message: `Authorization: Bearer ${SECRETS.accessToken}`,
        providerMessage: `refresh_token=${SECRETS.refreshToken}; client_secret=${SECRETS.clientSecret}`,
        providerReason: `Cookie: ${SECRETS.sessionCookie}`,
      }),
    );

    const text = serialized(safe);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  });

  it("redacts an unlabeled exact secret value standing alone in a sentence", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message: `Request rejected for ${SECRETS.accessToken} on this file.`,
        providerMessage: `The credential ${SECRETS.jwt} is not valid.`,
        providerReason: SECRETS.apiKey,
      }),
    );

    const text = serialized(safe);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it("redacts URL-encoded credentials the server-side label rules cannot see", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message: `Retry https://oauth2.googleapis.com/token?access_token%3D${encodeURIComponent(
          SECRETS.accessToken,
        )}`,
        providerMessage: `Authorization%3A%20Bearer%20${encodeURIComponent(SECRETS.refreshToken)}`,
      }),
    );

    const text = serialized(safe);
    for (const secret of SECRET_VALUES) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(encodeURIComponent(secret));
    }
  });

  it("redacts base64-shaped credentials, including a Basic header value", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message: `Authorization: Basic ${SECRETS.basic}`,
        providerMessage: `payload ${SECRETS.opaque} was rejected`,
      }),
    );

    const text = serialized(safe);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it("strips a query string from a URL rather than disclosing its parameters", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message:
          "GET https://www.googleapis.com/drive/v3/files?q=name+contains+'x'&pageToken=SECRETPAGETOKEN failed",
      }),
    );

    expect(safe?.message).not.toContain("SECRETPAGETOKEN");
    expect(safe?.message).not.toContain("pageToken");
    expect(safe?.message).toContain("https://www.googleapis.com/drive/v3/files");
  });

  it("omits a field entirely when redaction leaves nothing that can be read", () => {
    const safe = toSafeDiagnostic(
      envelope({
        message: "Google request failed.",
        providerMessage: SECRETS.opaque,
        providerStatus: `${SECRETS.jwt}`,
      }),
    );

    expect(safe?.providerMessage).toBeNull();
    expect(safe?.providerStatus).toBeNull();
    expect(safe?.message).toBe("Google request failed.");
  });

  it("returns null when nothing survives, so no empty panel is shown", () => {
    expect(
      toSafeDiagnostic({
        name: SECRETS.jwt,
        message: SECRETS.opaque,
        status: null,
        providerMessage: null,
        providerStatus: null,
        providerReason: null,
      }),
    ).toBeNull();
  });

  it("leaves an ordinary provider message readable", () => {
    const safe = toSafeDiagnostic(
      envelope({
        providerMessage: "The caller does not have permission",
        providerStatus: "PERMISSION_DENIED",
        providerReason: "forbidden",
      }),
    );

    expect(safe?.providerMessage).toBe("The caller does not have permission");
    expect(safe?.providerStatus).toBe("PERMISSION_DENIED");
    expect(safe?.providerReason).toBe("forbidden");
  });
});
