import {
  defineConfig,
  devices,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { encode } from "next-auth/jwt";
import { E2E_FIXTURE, toTestAccessToken } from "./src/lib/testing/fake-google-store";

/**
 * Browser proof against the real UI and the real Route Handlers.
 *
 * The web server runs `next dev`, so `NODE_ENV` is `development` and the
 * runtime guard permits the deterministic Drive/Sheets adapter. Nothing about
 * the application's own authorization is mocked or relaxed: the only thing
 * standing in for Google is the gateway pair behind `createGoogleGateways`, plus
 * the external Google Picker callback, which the browser could not reach from a
 * test anyway.
 *
 * One worker and no parallelism, because the deterministic store is a single
 * in-process world that every test reseeds through `POST /api/e2e/reset`.
 */

export const E2E_BASE_URL = "http://127.0.0.1:3100";

/** Must match the secret in the web-server command below. */
export const E2E_SECRET = "local-playwright-only";

/** Signed-in browser states produced by `tests/e2e/auth.setup.ts`. */
export const MANAGER_STORAGE_STATE = "test-results/e2e-auth/manager.json";
export const EMPLOYEE_STORAGE_STATE = "test-results/e2e-auth/employee.json";

/** Must match `AUTH_SECRET` in the web-server environment below. */
const E2E_AUTH_SECRET = "local-playwright-only-auth-secret";

/** Auth.js reads this cookie, and its name is also the JWT encryption salt. */
const SESSION_COOKIE = "authjs.session-token";

const SESSION_MAX_AGE_SECONDS = 60 * 60;

export { E2E_FIXTURE };

/* -------------------------------------------------------------------------- */
/* Shared test helpers                                                         */
/* -------------------------------------------------------------------------- */

export interface ResetRequest {
  /** Signs the calling browser context in as this fixture user. */
  signInAs?: string;
  /** Attendance saves that must fail before one succeeds. */
  attendanceSaveFailures?: number;
  /** Emails whose Drive invitation fails once. */
  inviteFailures?: readonly string[];
}

/**
 * Reseeds the deterministic world. Every test starts from the same fixture, so
 * no test depends on what another one wrote.
 *
 * `/api/e2e/reset` is protected by the ordinary application proxy like every
 * other API route, so this call only succeeds from an already signed-in
 * context — an anonymous probe is redirected to `/login` and never reaches the
 * handler at all.
 */
export async function resetStore(
  request: APIRequestContext,
  body: ResetRequest = {},
): Promise<void> {
  const response = await request.post(`${E2E_BASE_URL}/api/e2e/reset`, {
    headers: { "X-E2E-Secret": E2E_SECRET, "content-type": "application/json" },
    data: body,
    maxRedirects: 0,
  });

  if (response.status() !== 200) {
    throw new Error(`The E2E reset endpoint answered ${response.status()}.`);
  }
}

/**
 * Signs a browser context in as one fixture user.
 *
 * The proxy guards `/api/e2e/reset`, so the harness first presents the very
 * session the application's own adapter mints — the same encrypted Auth.js JWT,
 * carrying the same `e2e:<email>` access token the gateway factory reads — and
 * then lets `POST /api/e2e/reset` re-mint it and seed the store. Nothing about
 * the session pipeline is bypassed: the proxy, the server pages, and every
 * Route Handler run their committed checks against this cookie.
 */
export async function signInAs(context: BrowserContext, email: string): Promise<void> {
  const token = await encode({
    secret: E2E_AUTH_SECRET,
    salt: SESSION_COOKIE,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      email,
      sub: email,
      name: email,
      accessToken: toTestAccessToken(email),
      refreshToken: "e2e-refresh-token",
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    },
  });

  await context.addCookies([
    { name: SESSION_COOKIE, value: token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" },
  ]);

  await resetStore(context.request, { signInAs: email });
}

/**
 * Replaces the *external* Google Picker only.
 *
 * `loadPicker()` returns `window.google.picker` when it is already present, so
 * `apis.google.com` is never fetched. Everything the application owns —
 * `/api/google/picker-token`, folder revalidation, the setup file check — still
 * runs for real. Queue what the manager will pick with `queuePick`.
 */
export async function installPickerStub(page: Page): Promise<void> {
  await page.addInitScript({
    content: `
      (function () {
        var picks = [];
        window.__e2eQueuePick = function (item) { picks.push(item); };
        window.gapi = { load: function (name, callback) { callback(); } };

        function DocsView() {}
        DocsView.prototype.setIncludeFolders = function () { return this; };
        DocsView.prototype.setSelectFolderEnabled = function () { return this; };
        DocsView.prototype.setMimeTypes = function () { return this; };

        function PickerBuilder() { this.callback = null; }
        ["addView", "setOAuthToken", "setDeveloperKey", "setAppId", "setOrigin", "setLocale", "disableFeature"]
          .forEach(function (name) {
            PickerBuilder.prototype[name] = function () { return this; };
          });
        PickerBuilder.prototype.setCallback = function (callback) {
          this.callback = callback;
          return this;
        };
        PickerBuilder.prototype.build = function () {
          var callback = this.callback;
          return {
            setVisible: function (visible) {
              if (!visible) return;
              var next = picks.shift();
              callback(next ? { action: "picked", docs: [next] } : { action: "cancel" });
            },
          };
        };

        window.google = {
          picker: {
            Action: { PICKED: "picked", CANCEL: "cancel" },
            Feature: { MULTISELECT_ENABLED: "multiselectEnabled" },
            DocsView: DocsView,
            PickerBuilder: PickerBuilder,
          },
        };
      })();
    `,
  });
}

/** Queues the next item the stubbed Picker will hand back to the application. */
export async function queuePick(page: Page, item: { id: string; name: string }): Promise<void> {
  await page.evaluate(
    ([id, name]) => {
      (window as unknown as { __e2eQueuePick(item: { id: string; name: string }): void }).__e2eQueuePick(
        { id, name },
      );
    },
    [item.id, item.name] as const,
  );
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  // `next dev` compiles each route on first request, so the first browser
  // test to reach a route pays that cost; the budget is for a cold `.next`.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: E2E_BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command:
      "E2E_TEST_MODE=1 E2E_TEST_SECRET=local-playwright-only npm run dev -- --hostname 0.0.0.0 --port 3100",
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Local, non-production values only. The repository carries no secrets.
      AUTH_SECRET: "local-playwright-only-auth-secret",
      AUTH_URL: E2E_BASE_URL,
      AUTH_TRUST_HOST: "true",
      AUTH_GOOGLE_ID: "e2e-google-client-id",
      AUTH_GOOGLE_SECRET: "e2e-google-client-secret",
      NEXT_PUBLIC_GOOGLE_PICKER_API_KEY: "e2e-picker-api-key",
      NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER: "000000000000",
    },
  },
});
