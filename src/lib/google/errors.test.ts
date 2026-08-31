import { afterEach, describe, expect, it, vi } from "vitest";

import {
  debugErrorsEnabled,
  toGoogleErrorDiagnostic,
  type GoogleErrorDiagnostic,
} from "./errors";

/*
 * Spec §8.3 / §11.3: when `APP_DEBUG_ERRORS=1` the six-field
 * `GoogleErrorDiagnostic` envelope may reach the browser, but no representative
 * secret — raw, labeled, unlabeled, URL-encoded, or base64-shaped — may reach
 * the *response*. These tests assert the server boundary itself, not the
 * browser's own gate, so they serialize the envelope exactly as a route does
 * and assert on that text.
 *
 * Every secret below is obviously fake but shaped like the real thing.
 */

const FAKE_ACCESS_TOKEN = "ya29.a0AfB_FAKEnotarealtokenvalue0123456789abcdefghijkFAKE";
const FAKE_REFRESH_TOKEN = "1//0gFAKEnotarealrefreshvalue0123456789abcdefghijk";
const FAKE_CLIENT_SECRET = "GOCSPX-FAKEnotarealclientsecret01";
const FAKE_API_KEY = "AIzaSyFAKEnotarealapikeyvalue0123456789a";
const FAKE_BASE64_SECRET = "c2VjcmV0LXZhbHVlLWZvci10ZXN0aW5nLW9ubHktMDEyMzQ1Njc4OQ";
const FAKE_BASIC_CREDENTIAL = "ZmFrZS11c2VyOmZha2UtcGFzc3dvcmQtdmFsdWU=";
/** Short enough that only the Authorization rule itself can catch it. */
const FAKE_SHORT_BASIC_CREDENTIAL = "YWRtaW46ZmFrZQ==";
const FAKE_SHORT_OPAQUE_CREDENTIAL = "fake-opaque-cred";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmUtdmFsdWUtMDEyMw";
/** Every segment short enough that only the JWT rule can catch it. */
const FAKE_SHORT_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const FAKE_HEX_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

/** Builds the Gaxios-shaped failure a gateway actually receives. */
function googleFailure(options: {
  providerMessage?: string;
  causeMessage?: string;
  providerStatus?: string;
  providerReason?: string;
}): unknown {
  return Object.assign(new Error("Google request failed: files.list."), {
    name: "GoogleApiError",
    cause: {
      message: options.causeMessage ?? "Request failed with status code 403.",
      response: {
        status: 403,
        data: {
          error: {
            message: options.providerMessage ?? "Permission denied.",
            status: options.providerStatus ?? "PERMISSION_DENIED",
            errors: [{ reason: options.providerReason ?? "forbidden" }],
          },
        },
      },
    },
  });
}

function diagnosticFor(
  providerMessage: string,
  additionalSecrets: readonly string[] = [],
): GoogleErrorDiagnostic {
  return toGoogleErrorDiagnostic(googleFailure({ providerMessage }), additionalSecrets);
}

/** What a route actually writes into the response body. */
function serialized(diagnostic: GoogleErrorDiagnostic): string {
  return JSON.stringify(diagnostic);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("debugErrorsEnabled", () => {
  it("is on only for the exact server-side flag value", () => {
    expect(debugErrorsEnabled({ APP_DEBUG_ERRORS: "1" })).toBe(true);
    expect(debugErrorsEnabled({ APP_DEBUG_ERRORS: "true" })).toBe(false);
    expect(debugErrorsEnabled({})).toBe(false);
  });
});

describe("toGoogleErrorDiagnostic envelope", () => {
  it("exposes exactly the six allowlisted fields", () => {
    const diagnostic = toGoogleErrorDiagnostic(googleFailure({}));

    expect(Object.keys(diagnostic).sort()).toEqual([
      "message",
      "name",
      "providerMessage",
      "providerReason",
      "providerStatus",
      "status",
    ]);
    expect(diagnostic.status).toBe(403);
  });

  it("caps each field independently and never returns a raw stack or body", () => {
    const long = `Quota exceeded for project attendance. ${"reason ".repeat(600)}`;
    const diagnostic = diagnosticFor(long);

    expect(diagnostic.providerMessage).not.toBeNull();
    expect(diagnostic.providerMessage!.length).toBeLessThanOrEqual(2_001);
    expect(diagnostic.providerMessage!.endsWith("…")).toBe(true);
    expect(diagnostic.providerStatus).toBe("PERMISSION_DENIED");
  });

  it("falls back to safe defaults when nothing can be proven safe", () => {
    const diagnostic = toGoogleErrorDiagnostic({
      name: FAKE_BASE64_SECRET,
      message: FAKE_BASE64_SECRET,
      cause: {},
    });

    expect(serialized(diagnostic)).not.toContain(FAKE_BASE64_SECRET);
    expect(diagnostic.name).toBe("Error");
    expect(diagnostic.message).toBe("Unknown error.");
    expect(diagnostic.providerMessage).toBeNull();
  });
});

describe("negative redaction — labeled secrets", () => {
  it("redacts labels the value-based rules never knew about", () => {
    const diagnostic = diagnosticFor(
      `Rejected: api_key=${FAKE_API_KEY}; password=hunter2fakevalue; id_token=${FAKE_JWT}`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toContain("hunter2fakevalue");
    expect(text).not.toContain(FAKE_JWT);
    expect(diagnostic.providerMessage).toContain("api_key=[REDACTED]");
    expect(diagnostic.providerMessage).toContain("password=[REDACTED]");
  });

  it("redacts a hyphenated label variant", () => {
    const diagnostic = diagnosticFor(`Rejected: client-secret=${FAKE_CLIENT_SECRET}`);

    expect(serialized(diagnostic)).not.toContain(FAKE_CLIENT_SECRET);
  });

  it("still redacts the labels the original implementation covered", () => {
    const diagnostic = diagnosticFor(
      `access_token=${FAKE_ACCESS_TOKEN} refresh_token=${FAKE_REFRESH_TOKEN}`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain(FAKE_REFRESH_TOKEN);
  });
});

describe("negative redaction — unlabeled exact secrets", () => {
  it("redacts a configured application secret that appears with no label", () => {
    vi.stubEnv("AUTH_SECRET", FAKE_BASE64_SECRET);

    const diagnostic = diagnosticFor(`Signature mismatch near ${FAKE_BASE64_SECRET} in payload`);

    expect(serialized(diagnostic)).not.toContain(FAKE_BASE64_SECRET);
  });

  it("redacts a per-request access token passed as an additional secret", () => {
    const requestToken = "provider-access-token-fake";

    const diagnostic = diagnosticFor(`Token ${requestToken} was rejected`, [requestToken]);

    expect(serialized(diagnostic)).not.toContain(requestToken);
  });

  it("redacts a percent-encoded representation of a known secret", () => {
    const requestToken = "fake+access/token=value";

    const diagnostic = diagnosticFor(
      `Token ${encodeURIComponent(requestToken)} was rejected`,
      [requestToken],
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(requestToken);
    expect(text).not.toContain(encodeURIComponent(requestToken));
  });
});

describe("negative redaction — URL-encoded labels", () => {
  it("redacts a percent-encoded refresh_token parameter", () => {
    const encoded = `refresh_token%3D${encodeURIComponent(FAKE_REFRESH_TOKEN)}`;

    const diagnostic = diagnosticFor(`Body was ${encoded}`);

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_REFRESH_TOKEN);
    expect(text).not.toContain(encodeURIComponent(FAKE_REFRESH_TOKEN));
    expect(text).not.toContain("1%2F%2F");
    expect(diagnostic.providerMessage).toBe("Body was refresh_token=[REDACTED]");
  });

  it("redacts a percent-encoded client_secret parameter", () => {
    const diagnostic = diagnosticFor(
      `Body was client_secret%3D${encodeURIComponent(FAKE_CLIENT_SECRET)}%26grant_type%3Drefresh_token`,
    );

    expect(serialized(diagnostic)).not.toContain("GOCSPX-");
    expect(diagnostic.providerMessage).toBe("Body was client_secret=[REDACTED]");
  });

  it("does not break on a stray or literal percent sign", () => {
    const diagnostic = diagnosticFor("Quota 100% consumed; retry at 50%");

    expect(diagnostic.providerMessage).toBe("Quota 100% consumed; retry at 50%");
  });

  it("still redacts an encoded credential in a message that also has a bare percent", () => {
    const diagnostic = diagnosticFor(
      `Quota 100% consumed while sending access_token%3D${encodeURIComponent(FAKE_ACCESS_TOKEN)}`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain("ya29");
  });
});

describe("negative redaction — Authorization headers", () => {
  it("redacts the whole credential of an Authorization: Basic header", () => {
    const diagnostic = diagnosticFor(
      `Request failed with Authorization: Basic ${FAKE_BASIC_CREDENTIAL}`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_BASIC_CREDENTIAL);
    expect(text).not.toContain("ZmFrZS11c2Vy");
    expect(diagnostic.providerMessage).toBe("Request failed with Authorization: [REDACTED]");
  });

  /*
   * These two use credentials too short for the opaque-shape rule to catch, so
   * they isolate the Authorization rule itself: the header value must be
   * consumed whole, not just as far as the scheme word.
   */
  it("redacts a short Basic credential the shape rules would not catch", () => {
    const diagnostic = diagnosticFor(
      `Request failed with Authorization: Basic ${FAKE_SHORT_BASIC_CREDENTIAL}`,
    );

    expect(serialized(diagnostic)).not.toContain(FAKE_SHORT_BASIC_CREDENTIAL);
    expect(diagnostic.providerMessage).toBe("Request failed with Authorization: [REDACTED]");
  });

  it("redacts an Authorization header using any other scheme", () => {
    const diagnostic = diagnosticFor(
      `Authorization: SomeScheme ${FAKE_SHORT_OPAQUE_CREDENTIAL}, rejected by the proxy`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_SHORT_OPAQUE_CREDENTIAL);
    expect(text).not.toContain("SomeScheme");
    expect(diagnostic.providerMessage).toBe("Authorization: [REDACTED], rejected by the proxy");
  });

  it("redacts a long Authorization credential of any scheme", () => {
    const diagnostic = diagnosticFor(
      `Authorization: SomeScheme ${FAKE_HEX_SECRET} rejected by the proxy`,
    );

    expect(serialized(diagnostic)).not.toContain(FAKE_HEX_SECRET);
  });

  it("redacts a Bearer credential and a Cookie header", () => {
    const diagnostic = diagnosticFor(
      `Bearer ${FAKE_ACCESS_TOKEN} rejected, Cookie: __Secure-authjs.session-token=${FAKE_BASE64_SECRET}`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain(FAKE_BASE64_SECRET);
  });
});

describe("negative redaction — opaque shapes", () => {
  it("redacts an unlabeled base64 run", () => {
    const diagnostic = diagnosticFor(`Signature ${FAKE_BASE64_SECRET} did not verify`);

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_BASE64_SECRET);
    expect(diagnostic.providerMessage).toBe("Signature [REDACTED] did not verify");
  });

  it("redacts an unlabeled hex run", () => {
    const diagnostic = diagnosticFor(`Checksum ${FAKE_HEX_SECRET} did not match`);

    expect(serialized(diagnostic)).not.toContain(FAKE_HEX_SECRET);
    expect(diagnostic.providerMessage).toBe("Checksum [REDACTED] did not match");
  });

  it("redacts an unlabeled JWT", () => {
    const diagnostic = diagnosticFor(`Assertion ${FAKE_JWT} expired`);

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_JWT);
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts a JWT whose segments are individually too short for the run rule", () => {
    const diagnostic = diagnosticFor(`Assertion ${FAKE_SHORT_JWT} expired`);

    expect(serialized(diagnostic)).not.toContain(FAKE_SHORT_JWT);
    expect(diagnostic.providerMessage).toBe("Assertion [REDACTED] expired");
  });

  it("redacts every provider-specific credential prefix, unlabeled", () => {
    for (const secret of [
      FAKE_ACCESS_TOKEN,
      FAKE_REFRESH_TOKEN,
      FAKE_CLIENT_SECRET,
      FAKE_API_KEY,
    ]) {
      const diagnostic = diagnosticFor(`Credential ${secret} was rejected`);

      expect(serialized(diagnostic)).not.toContain(secret);
    }
  });

  it("removes a URL query string rather than returning it", () => {
    const diagnostic = diagnosticFor(
      `GET https://www.googleapis.com/drive/v3/files?access_token=${FAKE_ACCESS_TOKEN}&pageSize=100 failed`,
    );

    const text = serialized(diagnostic);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain("pageSize=100");
    expect(diagnostic.providerMessage).toContain("https://www.googleapis.com/drive/v3/files?");
  });

  it("removes a query string that carries no recognizable credential at all", () => {
    const diagnostic = diagnosticFor(
      "GET https://www.googleapis.com/drive/v3/files?corpora=user&pageSize=100 failed",
    );

    expect(diagnostic.providerMessage).toBe(
      "GET https://www.googleapis.com/drive/v3/files?[REDACTED] failed",
    );
  });
});

describe("positive — ordinary diagnostic text survives", () => {
  it("keeps a plain provider reason and status verbatim", () => {
    const diagnostic = toGoogleErrorDiagnostic(
      googleFailure({
        providerMessage: "File not found.",
        providerStatus: "NOT_FOUND",
        providerReason: "notFound",
      }),
    );

    expect(diagnostic.providerReason).toBe("notFound");
    expect(diagnostic.providerStatus).toBe("NOT_FOUND");
    expect(diagnostic.providerMessage).toBe("File not found.");
  });

  it("keeps a sheet title and A1 range readable", () => {
    const diagnostic = diagnosticFor("Unable to parse range: 勤怠管理表 2026-07!A1:AS40");

    expect(diagnostic.providerMessage).toBe("Unable to parse range: 勤怠管理表 2026-07!A1:AS40");
  });

  it("keeps the error name and message of the app's own gateway errors", () => {
    const diagnostic = toGoogleErrorDiagnostic(
      googleFailure({ providerMessage: "Google Drive API has not been used in project 12345." }),
    );

    expect(diagnostic.name).toBe("GoogleApiError");
    expect(diagnostic.message).toBe("Google request failed: files.list.");
    expect(diagnostic.providerMessage).toBe(
      "Google Drive API has not been used in project 12345.",
    );
  });

  it("keeps a Drive file id's message readable even though the opaque id is redacted", () => {
    const diagnostic = diagnosticFor(
      "File not found: 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    );

    expect(diagnostic.providerMessage).toBe("File not found: [REDACTED]");
  });
});
