import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  ApiErrorNotice,
  ErrorNotice,
  SESSION_EXPIRED_MESSAGE,
  describeApiFailure,
  toApiFailure,
  type ApiFailure,
} from "./api-error-notice";
import { toGoogleErrorDiagnostic } from "@/lib/google/errors";

/**
 * The representative secrets spec §11.3 names, in the four shapes it names them
 * in: labeled, unlabeled, URL-encoded, and base64-shaped. They travel together
 * so a rule that stops covering one of them fails a test rather than shipping.
 */
const SECRETS = {
  accessToken: "ya29.a0AfB_bQm7SECRETACCESSTOKENvalue1234",
  refreshToken: "1//04SECRETREFRESHTOKENvalue5678",
  clientSecret: "GOCSPX-SECRETclientSECRETvalue90",
  authSecret: "SECRETauthSecretValueForTheAppItself",
  basic: "ZGV2LWNsaWVudDpHT0NTUFgtU0VDUkVUdmFsdWU=",
  cookie: "authjs.session-token=SECRETcookieVALUE0987654321",
} as const;

const SECRET_VALUES: readonly string[] = Object.values(SECRETS);

/**
 * A gaxios-shaped rejection carrying every secret shape at once, arranged so
 * each one lands in a different field of the envelope the gateway produces.
 */
function leakyGoogleError(): unknown {
  return {
    name: "GoogleApiError",
    message:
      `Google request failed: files.list. Authorization: Bearer ${SECRETS.accessToken}. ` +
      `Retry https://oauth2.googleapis.com/token?refresh_token%3D` +
      `${encodeURIComponent(SECRETS.refreshToken)} and Authorization: Basic ${SECRETS.basic}`,
    cause: {
      response: {
        status: 403,
        data: {
          error: {
            message: `client_secret=${SECRETS.clientSecret}; ${SECRETS.authSecret} rejected`,
            status: "PERMISSION_DENIED",
            errors: [{ reason: `forbidden (${SECRETS.cookie})`, domain: "global" }],
          },
        },
      },
    },
  };
}

function domText(container: HTMLElement): string {
  return `${container.innerHTML}\n${container.textContent ?? ""}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Retained API-failure contract                                               */
/* -------------------------------------------------------------------------- */

describe("API failure contract", () => {
  it("reads a carried failure and falls back to status 0 for anything else", () => {
    const failure: ApiFailure = { status: 409, code: "duplicate-member-email" };

    expect(toApiFailure({ failure })).toEqual(failure);
    expect(toApiFailure(new Error("boom"))).toEqual({ status: 0 });
  });

  it("prefers this application's own copy for a known code", () => {
    expect(describeApiFailure({ status: 409, code: "duplicate-member-email" }, "Fallback.")).toBe(
      "Each member must have a different email address.",
    );
  });

  it("never renders a provider message for a Google boundary failure", () => {
    expect(
      describeApiFailure({ status: 502, message: "quota exceeded for project 1234" }, "Fallback."),
    ).toBe("Fallback.");
  });

  it("answers an expired session with one sentence, whatever the route said", () => {
    expect(describeApiFailure({ status: 401, message: "nope" }, "Fallback.")).toBe(
      SESSION_EXPIRED_MESSAGE,
    );
  });
});

describe("ApiErrorNotice — the wizards' existing surface", () => {
  it("renders nothing at all when there is no failure", () => {
    const { container } = render(<ApiErrorNotice failure={null} fallbackMessage="Fallback." />);

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the sign-in link the wizards already assert on", () => {
    render(<ApiErrorNotice failure={{ status: 401 }} fallbackMessage="Fallback." />);

    expect(screen.getByRole("alert")).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("offers Try again for an actionable failure and hides it once sign-in is needed", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ApiErrorNotice failure={{ status: 500 }} fallbackMessage="Fallback." onRetry={onRetry} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ApiErrorNotice failure={{ status: 403 }} fallbackMessage="Fallback." onRetry={onRetry} />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* ErrorNotice — recovery                                                      */
/* -------------------------------------------------------------------------- */

describe("ErrorNotice — recovery actions", () => {
  it("states what happened and whether the data is safe", () => {
    render(
      <ErrorNotice
        title="Could not load your dashboard"
        detail="Google Drive did not respond. Your locally saved attendance is unchanged."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load your dashboard");
    expect(screen.getByText(/locally saved attendance is unchanged/)).toBeVisible();
  });

  it("renders each recovery action only when the caller wires it", () => {
    const handlers = { onRetry: vi.fn(), onResume: vi.fn(), onReload: vi.fn() };
    render(<ErrorNotice title="Setup did not finish" {...handlers} reauthenticate />);

    for (const [name, handler] of [
      ["Try again", handlers.onRetry],
      ["Resume", handlers.onResume],
      ["Reload", handlers.onReload],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(handler).toHaveBeenCalledTimes(1);
    }

    expect(screen.getByRole("link", { name: "Re-authenticate" })).toHaveAttribute("href", "/login");
  });

  it("disables every recovery button while one is running", () => {
    render(<ErrorNotice title="Boom" onRetry={() => undefined} onReload={() => undefined} busy />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
  });

  it("keeps a card-scoped failure a card, so one broken file cannot fail a page", () => {
    const { container } = render(<ErrorNotice title="This file could not be read" scope="card" />);

    expect(container.querySelector(".api-error-card")).not.toBeNull();
    expect(container.querySelector(".api-error-page")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* ErrorNotice — sanitized debug disclosure                                    */
/* -------------------------------------------------------------------------- */

describe("ErrorNotice — debug disclosure is absent unless the server sent one", () => {
  it("shows no technical details when the server omitted the envelope", () => {
    render(<ErrorNotice title="Could not load your dashboard" />);

    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByRole("group", { name: "Technical details" })).toBeNull();
  });

  it("shows no technical details for an explicitly null envelope", () => {
    render(<ErrorNotice title="Could not load your dashboard" diagnostic={null} />);

    expect(screen.queryByText("Technical details")).toBeNull();
  });

  it("shows no technical details when nothing in the envelope survives sanitization", () => {
    render(
      <ErrorNotice
        title="Could not load your dashboard"
        diagnostic={{
          name: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRUNSRVQifQ.c2lnbmF0dXJlU0VDUkVU",
          message: "c2VjcmV0LXBheWxvYWQtdmFsdWUtdGhhdC1pcy1sb25n",
          status: null,
          providerMessage: null,
          providerStatus: null,
          providerReason: null,
        }}
      />,
    );

    expect(screen.queryByText("Technical details")).toBeNull();
  });

  it("discloses the envelope collapsed, never open by default", () => {
    render(
      <ErrorNotice
        title="Could not load your dashboard"
        diagnostic={{
          name: "GoogleApiError",
          message: "Google request failed: files.list.",
          status: 403,
          providerMessage: "The caller does not have permission",
          providerStatus: "PERMISSION_DENIED",
          providerReason: "forbidden",
        }}
      />,
    );

    const details = screen.getByText("Technical details").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("The caller does not have permission")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("PERMISSION_DENIED")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("403")).toBeInTheDocument();
  });

  it("renders only the six allowlisted fields, never an unknown one", () => {
    const { container } = render(
      <ErrorNotice
        title="Could not load your dashboard"
        diagnostic={{
          name: "GoogleApiError",
          message: "Google request failed: files.list.",
          status: 403,
          providerMessage: "The caller does not have permission",
          providerStatus: "PERMISSION_DENIED",
          providerReason: "forbidden",
          requestId: "7fd2-UNKNOWNFIELD",
          url: "https://www.googleapis.com/drive/v3/files?pageToken=SECRETPAGETOKEN",
          stack: "GoogleApiError: boom\n    at drive-gateway.ts:42",
          config: { headers: { authorization: "Bearer SECRETheaderTOKENvalue" } },
        }}
      />,
    );

    const text = domText(container);
    for (const leak of [
      "7fd2-UNKNOWNFIELD",
      "requestId",
      "SECRETPAGETOKEN",
      "drive-gateway.ts",
      "SECRETheaderTOKENvalue",
      "Bearer SECRET",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("ErrorNotice — negative redaction, all four secret shapes", () => {
  it("keeps every representative secret out of the DOM, end to end from the gateway", () => {
    vi.stubEnv("AUTH_SECRET", SECRETS.authSecret);
    vi.stubEnv("AUTH_GOOGLE_SECRET", SECRETS.clientSecret);

    const diagnostic = toGoogleErrorDiagnostic(leakyGoogleError(), [SECRETS.accessToken]);
    const { container } = render(
      <ErrorNotice title="Could not load your dashboard" diagnostic={diagnostic} />,
    );

    const text = domText(container);
    for (const secret of SECRET_VALUES) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(encodeURIComponent(secret));
    }
    expect(text).not.toContain("Bearer ya29");
    expect(text).not.toContain("oauth2.googleapis.com/token?refresh_token");
  });

  it("keeps them out even when the envelope reaches the browser unsanitized", () => {
    const { container } = render(
      <ErrorNotice
        title="Could not load your dashboard"
        diagnostic={{
          name: "GoogleApiError",
          message: `Authorization: Bearer ${SECRETS.accessToken}`,
          status: 403,
          providerMessage: `refresh_token%3D${encodeURIComponent(SECRETS.refreshToken)}`,
          providerStatus: `Basic ${SECRETS.basic}`,
          providerReason: SECRETS.cookie,
        }}
      />,
    );

    const text = domText(container);
    for (const secret of SECRET_VALUES) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(encodeURIComponent(secret));
    }
  });

  it("never persists a diagnostic to browser storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open, deleteDatabase: vi.fn(), databases: vi.fn() });

    render(
      <ErrorNotice
        title="Could not load your dashboard"
        diagnostic={{
          name: "GoogleApiError",
          message: "Google request failed: files.list.",
          status: 403,
          providerMessage: "The caller does not have permission",
          providerStatus: "PERMISSION_DENIED",
          providerReason: "forbidden",
        }}
      />,
    );

    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
