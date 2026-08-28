# Google Sheets Attendance App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized English-language Next.js application that uses each signed-in user's Google OAuth authority to create, import, discover, share, protect, and edit monthly Google Sheets attendance files.

**Architecture:** The Next.js App Router is both the web UI and the backend-for-frontend. Pure attendance and workbook-contract modules own deterministic rules; server-only Google gateways own OAuth-authenticated Drive/Sheets calls; orchestration services compose those boundaries for create/import/member/save flows; Route Handlers re-authorize every request; React client components own transient editor and Google Picker state. Google Sheets and protected `__APP_CONFIG` tabs remain the only product datastore, while the selected manager folder is a non-authoritative browser preference.

**Tech Stack:** Node.js 24 LTS on Debian slim in Docker, Next.js 16.3.3, React 19.2.8, TypeScript, Auth.js/NextAuth 5 beta, Google APIs Node client 176.0.0, Google Picker, ExcelJS 4.4.0, Zod 4.4.3, Vitest 4.1.x, React Testing Library 16.3.2, Playwright 1.62.1, native CSS.

---

Date: 2026-08-28  
Status: Active

## Outcome

The repository contains a production-buildable Next.js application that:

- signs users in with Google and refreshes short-lived provider tokens without a database;
- creates or converts monthly attendance spreadsheets directly in a manager-selected owned My Drive folder;
- shares each file with manually entered Workspace emails and protects each employee tab;
- discovers manager files only among direct children of the active folder and employee files only when the owner/domain/name/config mapping rules pass;
- lets employees modify only their mapped sheet through the application;
- exposes synchronized timeline and work-block editing, 30-minute slots, lunch exclusion, status enum, notes, exact dirty-range saving, and work-hour calculation;
- builds, tests, starts, and reports readiness through Docker; and
- documents the Google Cloud prerequisites and the live-integration proof that still requires user-supplied credentials.

## Context And Authority

- Approved product and technical contract: [`docs/specs/2026-08-28-google-sheets-attendance-design.md`](../../specs/2026-08-28-google-sheets-attendance-design.md).
- Repository workflow and completion rules: [`docs/WORKFLOW.md`](../../WORKFLOW.md).
- Reference workbook for final compatibility inspection: repository-root `202607勤怠管理表.xlsx` (read-only input; product code must not depend on this path).
- Google Picker folder selection: <https://developers.google.com/workspace/drive/picker/reference/picker.docsview>.
- Drive parent placement and one-parent rule: <https://developers.google.com/workspace/drive/api/guides/folder>.
- Drive scopes: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>.
- Sheets batch updates and protected ranges: <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate>.
- Next.js standalone Docker output: <https://nextjs.org/docs/app/api-reference/config/next-config-js/output>.

The user-approved specification is authority for all externally observable behavior in this plan. Package versions, module boundaries, npm, native CSS, and the test seam are task-local implementation decisions.

## Scope

In scope:

- One Next.js application, one Docker image, and one Compose definition.
- Google OAuth identity, Sheets read/write, `drive.file`, and `drive.metadata.readonly`.
- My Drive folders owned by the current user; one active direct-parent folder at a time.
- New monthly file creation and `.xlsx` import/Google Sheets conversion.
- Adding members, but not removing them.
- English website copy with Japanese workbook-contract values.
- Deterministic automated tests with fake Google gateways plus an optional live Google smoke test.

Out of scope:

- Google Workspace Admin SDK or automatic employee directory discovery.
- Shared Drives, recursive folder traversal, database persistence, audit history, analytics, member removal, access revocation, per-tab viewing confidentiality, or same-cell conflict prevention.
- Deployment to a specific cloud provider, CI configuration, branch protection, and real OAuth credential creation.

## File And Module Map

| Area | Files | Responsibility |
| --- | --- | --- |
| Runtime | `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `.gitignore` | Reproducible Docker-first build, scripts, environment contract, non-root runtime |
| App shell | `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/app/api/health/route.ts` | English shell, sign-in landing page, shared visual tokens, readiness |
| Auth | `src/auth.ts`, `src/auth.config.ts`, `src/proxy.ts`, `src/types/next-auth.d.ts`, `src/lib/auth/google-token.ts`, `src/lib/auth/session.ts` | Google OAuth scopes, encrypted JWT session, refresh, normalized verified identity, route protection |
| Attendance domain | `src/lib/attendance/model.ts`, `time.ts`, `slots.ts`, `validation.ts`, `range-mapper.ts` | Pure day model, decimal-time conversion, half-hour slots, lunch/work-block rules, dirty A1 ranges |
| Workbook contract | `src/lib/workbook/contract.ts`, `template.ts`, `xlsx-inspector.ts` | Reference columns/headers, monthly rows/formulas/styles, import recognition |
| Google boundaries | `src/lib/google/types.ts`, `client.ts`, `drive-gateway.ts`, `sheets-gateway.ts`, `picker.ts`, `errors.ts` | Small typed wrappers around Drive/Sheets/Picker and normalized errors |
| Sheet-native config | `src/lib/config/schema.ts`, `repository.ts` | Fixed `__APP_CONFIG` schema read/write, app properties, setup state |
| Authorization | `src/lib/access/policy.ts` | Per-request current-owner or exact employee-sheet authorization |
| Orchestration | `src/lib/files/setup-service.ts`, `import-service.ts`, `member-service.ts`, `src/lib/discovery/file-discovery.ts`, `src/lib/attendance/service.ts` | Idempotent, retryable application use cases over injected gateways |
| API | `src/app/api/dashboard/route.ts`, `google/picker-token/route.ts`, `folders/validate/route.ts`, `files/create/route.ts`, `files/import/inspect/route.ts`, `files/import/route.ts`, `files/[fileId]/setup/route.ts`, `files/[fileId]/members/route.ts`, `files/[fileId]/attendance/[sheetId]/route.ts` | Validated JSON/multipart boundary, session lookup, authorization, safe error responses |
| Dashboard/folders | `src/app/(authenticated)/dashboard/page.tsx`, `dashboard-client.tsx`, `src/components/google-picker.tsx`, `src/lib/dashboard/folder-preference.ts` | Role-aware cards, browser-local folder preference, folder/file Picker |
| Manager UI | `src/app/(authenticated)/files/new/page.tsx`, `new-file-wizard.tsx`, `src/app/(authenticated)/files/import/page.tsx`, `import-wizard.tsx`, `src/app/(authenticated)/files/[fileId]/setup/page.tsx`, `legacy-setup-wizard.tsx`, `src/app/(authenticated)/files/[fileId]/members/page.tsx`, `member-form.tsx`, `src/components/member-rows.tsx` | Create/import/legacy setup/member workflows and partial-failure resume states |
| Attendance UI | `src/app/(authenticated)/files/[fileId]/attendance/[sheetId]/page.tsx`, `attendance-editor.tsx`, `src/components/day-summary.tsx`, `timeline-editor.tsx`, `work-block-form.tsx` | Month/day navigation and two synchronized editing modes |
| Proof | `src/**/*.test.ts(x)`, `src/lib/testing/runtime-guard.ts`, `fake-google-store.ts`, `src/app/api/e2e/reset/route.ts`, `tests/e2e/*.spec.ts`, `tests/fakes/*.ts`, `tests/fixtures/workbook.ts`, `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts` | Unit, integration, browser, security, and recovery proof |
| Operations | `README.md`, `docs/product/attendance.md`, `docs/runbooks/google-cloud-setup.md` | Product behavior, local Docker commands, Google Cloud configuration, live smoke checklist |

## Approach And Dependency Order

1. Establish the Docker/Next/test foundation and prove the image before feature work.
2. Implement pure attendance/workbook rules with TDD.
3. Add OAuth/session handling and typed Google boundaries.
4. Add sheet-native config and authorization before exposing mutations.
5. Implement create/import/member orchestration behind fake gateways.
6. Add dashboard and manager UI over the tested service/API contracts.
7. Add attendance read/save and the synchronized editor.
8. Run negative authorization tests, browser flows, reference-workbook inspection, Docker build/readiness, and optional live smoke proof.

## Risks And Recovery

- **OAuth organization approval:** `drive.metadata.readonly` may require organization approval. Keep all deterministic proof runnable with fake gateways; record live smoke as blocked until credentials/approval exist.
- **Auth.js beta API drift:** pin `next-auth@5.0.0-beta.32` in `package-lock.json`, isolate Auth.js calls in `src/auth.ts` and `src/lib/auth/`, and do not spread library types through domain modules.
- **Partial Google setup:** persist `pending` and per-member setup status before invitations; never delete a created/converted file automatically; return file/folder IDs so the UI exposes resume.
- **Authorization regression:** every Route Handler calls `requireGoogleSession` and the access-policy service; negative tests prove an employee cannot address another sheet ID.
- **Picker/browser token exposure:** return only the short-lived access token on demand with `Cache-Control: no-store`; never return refresh tokens; keep the token in component memory and pass it directly to Picker.
- **Reference conversion differences:** inspect locally with ExcelJS before upload, upload the original bytes unchanged for Drive conversion, then reconcile only the reserved config/protection contract.
- **Working-tree recovery:** commit after each task. If a task fails, revert only that task's files or continue from its last passing commit; never delete retained Google files as rollback.

## Progress

### Task 1: Docker-First Next.js Foundation

**Files:**

- Create: `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `next-env.d.ts`, `eslint.config.mjs`
- Create: `vitest.config.ts`, `vitest.setup.ts`, `src/app/api/health/route.test.ts`
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `.env`
- Modify: `.gitignore`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/app/api/health/route.ts`, `public/.gitkeep`, `README.md`

- [x] **Step 1: Create the pinned npm and TypeScript/tooling contract**

Create `package.json` with these exact scripts and dependency versions, then generate `package-lock.json` from the pinned manifest inside `node:24.19.0-bookworm-slim`:

```json
{
  "name": "google-sheets-attendance",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=24.19.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "verify": "npm run lint && npm run typecheck && npm test && npm run build"
  },
  "dependencies": {
    "exceljs": "4.4.0",
    "googleapis": "176.0.0",
    "next": "16.3.3",
    "next-auth": "5.0.0-beta.32",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "1.62.1",
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.2",
    "@types/node": "24.10.0",
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.2",
    "eslint": "9.39.1",
    "eslint-config-next": "16.3.3",
    "jsdom": "30.0.1",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

Run:

```bash
docker run --rm --volume "$PWD:/app" --workdir /app node:24.19.0-bookworm-slim npm install --package-lock-only
```

Expected: exit 0 and a lockfile with `lockfileVersion: 3`; do not run a host-side build.

- [x] **Step 2: Create configuration, environment, and secret-exclusion files**

`next.config.ts` must export `{ output: "standalone" }`. `vitest.config.ts` uses the `jsdom` environment, `@/` alias to `src/`, `vitest.setup.ts`, and excludes `tests/e2e/**`. Extend `.gitignore` with:

```gitignore
node_modules/
.next/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
!.env.e2e.example
.brainstorm/
~$*.xlsx
```

Create both `.env.example` and the ignored local `.env` with these names; `.env.example` uses descriptive empty values and `.env` remains uncommitted:

```dotenv
AUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
AUTH_URL=http://localhost:3000
AUTH_TRUST_HOST=true
NEXT_PUBLIC_GOOGLE_PICKER_API_KEY=
NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER=
```

Run `git check-ignore .env` and expect `.env`; run `git check-ignore .env.example` and expect exit 1.

- [x] **Step 3: Write the failing health-route test**

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports readiness without loading Google credentials", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
```

Run `docker compose run --rm test npm test -- src/app/api/health/route.test.ts` before creating the route. Expected: FAIL because `./route` does not exist.

- [x] **Step 4: Implement the minimal app shell and readiness route**

Implement the route exactly at the unauthenticated boundary:

```ts
export function GET() {
  return Response.json(
    { status: "ok" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
```

Create an English landing page with product name, one-sentence explanation, and a temporarily disabled `Sign in with Google` button that Task 3 will wire. Define CSS custom properties for background, surface, text, muted text, border, primary, danger, warning, success, focus ring, spacing, radius, and shadow; use responsive native CSS without a component library.

Run the focused test again. Expected: PASS (1 test).

- [x] **Step 5: Create and prove the multi-stage Docker image**

Use `node:24.19.0-bookworm-slim` for `deps`, `test`, `builder`, and non-root `runner` stages. The test stage installs Playwright Chromium and its Debian dependencies; the builder runs `npm run build`; the runner copies `.next/standalone`, `.next/static`, and `public`, listens on port 3000, runs `node server.js` as UID/GID 1001, and uses Node's built-in `fetch` for its health check. `compose.yaml` defines `app` (runner target, `.env`, port `3000:3000`) and `test` (test target, source bind mount plus an isolated `/app/node_modules` volume so focused tests exercise current files without rebuilding the image).

Run:

```bash
docker compose build test
docker compose run --rm test npm run lint
docker compose run --rm test npm run typecheck
docker compose run --rm test npm test
docker compose build app
```

Expected: every command exits 0. Start with `docker compose up --detach app`, request `http://localhost:3000/api/health`, expect `{"status":"ok"}`, then stop only this Compose project with `docker compose down`.

- [x] **Step 6: Commit the foundation**

```bash
git add .gitignore .dockerignore .env.example Dockerfile compose.yaml package.json package-lock.json next.config.ts tsconfig.json next-env.d.ts eslint.config.mjs vitest.config.ts vitest.setup.ts public src/app README.md
git commit -m "chore: scaffold Dockerized Next.js app"
```

### Task 2: Attendance Domain, Time Slots, Lunch, And Dirty Ranges

**Files:**

- Create: `src/lib/attendance/model.ts`, `time.ts`, `slots.ts`, `validation.ts`, `range-mapper.ts`
- Test: `src/lib/attendance/time.test.ts`, `slots.test.ts`, `validation.test.ts`, `range-mapper.test.ts`

- [x] **Step 1: Write failing tests for the domain contract**

Tests must cover these concrete examples:

```ts
expect(decimalToTime(8)).toBe("08:00");
expect(decimalToTime(17.5)).toBe("17:30");
expect(timeToDecimal("23:30")).toBe(23.5);
expect(TIME_SLOTS).toHaveLength(36);
expect(TIME_SLOTS.at(0)).toBe("06:00");
expect(TIME_SLOTS.at(-1)).toBe("23:30");

const changed = applyWorkBlock(emptyDay("2026-07-01"), {
  start: "09:00",
  end: "10:00",
  description: "Client report",
});
expect(changed.slots["09:00"]).toBe("Client report");
expect(changed.slots["09:30"]).toBe("Client report");
expect(changed.slots["10:00"]).toBe("");

const lunch = setLunchBreak(changed, true);
expect(lunch.breakHours).toBe(1);
expect(lunch.slots["12:00"]).toBe("");
expect(lunch.slots["12:30"]).toBe("");
expect(isSlotWritable(lunch, "12:00")).toBe(false);
expect(calculateWorkHours({ clockIn: 8, clockOut: 17.5, breakHours: 1 })).toBe(8.5);
```

Also assert rejection of non-30-minute boundaries, empty descriptions, `end <= start`, negative work hours, break greater than duration, and a block whose only covered slots are reserved lunch slots.

Run `docker compose run --rm test npm test -- src/lib/attendance`. Expected: FAIL because the domain modules do not exist.

- [x] **Step 2: Define one canonical day model and time primitives**

Implement these public types and constants; other layers must import them rather than redefining attendance fields:

```ts
export type TimeSlot = `${string}:${"00" | "30"}`;
export type WorkBlockBoundary = TimeSlot | "24:00";
export type StatusCode = string;

export interface AttendanceDay {
  date: string;
  statusCode: StatusCode | null;
  clockIn: number | null;
  clockOut: number | null;
  breakHours: number;
  workHours: number | null;
  lunchBreak: boolean;
  notes: string;
  slots: Record<TimeSlot, string>;
}

export const STATUS_OPTIONS = [
  { code: "office", labelEn: "Office", sheetValue: "出社" },
  { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
] as const;
```

`time.ts` converts only valid `:00`/`:30` values and decimal halves. `slots.ts` creates exactly 06:00 through 23:30, permits `24:00` only as a work-block end boundary so the 23:30 slot can be filled, uses `[start,end)`, returns the list of overwritten non-empty slots for confirmation, skips lunch when enabled, and never mutates its input.

- [x] **Step 3: Implement validation and exact dirty A1 mapping**

Define `validateAttendanceDay(day, configuredStatuses): ValidationIssue[]` with stable issue codes: `invalid-boundary`, `clock-order`, `break-negative`, `break-too-long`, `work-hours-negative`, `unknown-status`, and `empty-work-block`. Define `diffDay(baseline,current,row): CellPatch[]` where:

```ts
export interface CellPatch {
  range: string;
  baseline: string | number | null;
  value: string | number | null;
}
```

Map D/I and J:AS exactly; work-hours column H is never client-written because it is a sheet formula. A one-slot edit at 09:00 produces one patch such as `{ range: "P7", ... }`, not a row-wide range.

Run all Task 2 tests. Expected: PASS.

- [x] **Step 4: Commit the pure domain**

```bash
git add src/lib/attendance
git commit -m "feat: add attendance editing domain"
```

### Task 3: Google OAuth Session And Token Refresh

**Files:**

- Create: `src/auth.config.ts`, `src/auth.ts`, `src/proxy.ts`, `src/types/next-auth.d.ts`
- Create: `src/lib/auth/google-token.ts`, `src/lib/auth/session.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`, `src/app/login/page.tsx`, `src/components/sign-in-button.tsx`
- Modify: `src/app/page.tsx`, `src/app/layout.tsx`
- Test: `src/lib/auth/google-token.test.ts`, `src/lib/auth/session.test.ts`

- [x] **Step 1: Write failing token/session tests**

Use injected `fetch` and clock functions. Assert that an unexpired token is returned unchanged, an expired token posts the refresh token to `https://oauth2.googleapis.com/token`, a successful refresh preserves the old refresh token when Google omits a new one, and failure yields `error: "RefreshAccessTokenError"`. Assert that `requireGoogleSession` lowercases `Manager@Blended-Asia.com` and rejects missing email, access token, or refresh error.

```ts
await expect(
  refreshGoogleToken(expiredToken, fakeFetch, () => 1_788_000_000_000),
).resolves.toMatchObject({ accessToken: "new-access", refreshToken: "refresh-1" });

await expect(requireGoogleSession({
  session: { user: { email: "Manager@Blended-Asia.com" } },
  token: { accessToken: "a" },
}))
  .resolves.toMatchObject({ email: "manager@blended-asia.com", accessToken: "a" });
```

Run the two test files. Expected: FAIL because the modules do not exist.

- [x] **Step 2: Configure Google OAuth and encrypted JWT sessions**

Export one scope constant:

```ts
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;
```

Configure the Google provider with `access_type=offline`, `prompt=consent`, and the joined scope string. Use Auth.js JWT session strategy. On initial login store `access_token`, `refresh_token`, and absolute expiry in the encrypted JWT; refresh only after expiry. The browser-visible session callback exposes normalized email and a typed refresh error only. `src/lib/auth/session.ts` uses the server-only `next-auth/jwt` decoder to read the encrypted JWT and obtain the short-lived access token for `requireGoogleSession`; neither access nor refresh token appears in the general `/api/auth/session` JSON response.

`src/app/api/auth/[...nextauth]/route.ts` exports `GET` and `POST` handlers. `src/proxy.ts` protects all UI/API routes except `/`, `/login`, `/api/auth/**`, and `/api/health`; every protected Route Handler still performs its own session/authorization checks.

- [x] **Step 3: Wire English sign-in/sign-out UI and secure response behavior**

Replace the temporarily disabled landing action with `signIn("google", { redirectTo: "/dashboard" })`. Add a server-action sign-out control to the authenticated layout. `requireGoogleSession` returns a domain `UnauthenticatedError`; API error mapping converts it to a generic English 401 response and never logs token values.

Run Task 3 tests, lint, and typecheck. Expected: PASS.

- [x] **Step 4: Commit authentication**

```bash
git add src/auth.config.ts src/auth.ts src/proxy.ts src/types src/lib/auth src/app/api/auth src/app/login src/components/sign-in-button.tsx src/app/page.tsx src/app/layout.tsx
git commit -m "feat: add Google OAuth sessions"
```

### Task 4: Typed Google Drive, Sheets, And Picker Boundaries

**Files:**

- Create: `src/lib/google/types.ts`, `client.ts`, `drive-gateway.ts`, `sheets-gateway.ts`, `picker.ts`, `errors.ts`
- Create: `src/app/api/google/picker-token/route.ts`, `src/app/api/folders/validate/route.ts`
- Create: `src/components/google-picker.tsx`
- Test: `src/lib/google/drive-gateway.test.ts`, `sheets-gateway.test.ts`, `src/app/api/google/picker-token/route.test.ts`
- Test fixtures: `tests/fakes/google.ts`

- [ ] **Step 1: Write failing Drive folder and pagination tests**

Using a fake Drive client, assert:

```ts
await expect(gateway.validateManagerFolder("folder-1")).resolves.toEqual({
  id: "folder-1",
  name: "Attendance 2026",
});

expect(fakeDrive.getCalls[0].fields).toBe(
  "id,name,mimeType,trashed,ownedByMe,driveId,capabilities(canAddChildren)",
);

expect(fakeDrive.listCalls[0].q).toContain("'folder-1' in parents");
expect(fakeDrive.listCalls[0].q).toContain("trashed = false");
expect(fakeDrive.listCalls).toHaveLength(2); // nextPageToken was followed
```

Reject folder MIME mismatches, `trashed=true`, `ownedByMe=false`, any `driveId`, and `canAddChildren !== true` with `FolderUnavailableError`. Assert manager result post-filtering uses case-sensitive `name.includes("勤怠管理表")`, `ownedByMe`, and direct query results only.

Run the tests. Expected: FAIL because the gateways do not exist.

- [ ] **Step 2: Define gateway interfaces and implement Drive operations**

Keep services dependent on these interfaces, not `googleapis` response types:

```ts
export interface DriveGateway {
  validateManagerFolder(folderId: string): Promise<DriveFolder>;
  listManagerFiles(folderId: string): Promise<AttendanceFileSummary[]>;
  listEmployeeCandidates(): Promise<AttendanceFileSummary[]>;
  getFileAccess(fileId: string): Promise<DriveFileAccess>;
  createSpreadsheetFile(input: CreateDriveSpreadsheetInput): Promise<CreatedDriveFile>;
  convertXlsx(input: ConvertXlsxInput): Promise<CreatedDriveFile>;
  createWriterPermission(fileId: string, email: string): Promise<string>;
  updateAppProperties(fileId: string, properties: Record<string, string>): Promise<void>;
}

export interface SheetsGateway {
  getSpreadsheet(fileId: string, fields?: string): Promise<SpreadsheetSnapshot>;
  batchUpdate(fileId: string, requests: SheetRequest[]): Promise<BatchUpdateResult>;
  getValues(fileId: string, ranges: string[]): Promise<RangeValues[]>;
  updateValues(fileId: string, patches: ValuePatch[]): Promise<void>;
}
```

`createSpreadsheetFile` calls Drive `files.create` with the Google Sheets MIME type and exactly `parents: [folderId]`. `convertXlsx` sends original bytes as XLSX media while request metadata uses the Sheets MIME type, confirmed output name, and exactly one parent. Permission calls use `sendNotificationEmail: true` and are invoked sequentially by services, never with `Promise.all`.

- [ ] **Step 3: Implement the Picker boundary and on-demand token route**

`GooglePicker` accepts `mode: "folder" | "spreadsheet"`, a callback, and no token prop. On open it requests `/api/google/picker-token`, keeps the access token only in component memory, loads `https://apis.google.com/js/api.js`, and builds:

```ts
const view = new google.picker.DocsView()
  .setIncludeFolders(mode === "folder")
  .setSelectFolderEnabled(mode === "folder")
  .setMimeTypes(
    mode === "folder"
      ? "application/vnd.google-apps.folder"
      : "application/vnd.google-apps.spreadsheet",
  );
```

Set OAuth token, referrer-restricted developer key, Cloud project number app ID, origin, single selection, and English locale. The token route requires a valid session and returns `{ accessToken }` with `Cache-Control: private, no-store`; it never serializes the refresh token. Folder selection is incomplete until `/api/folders/validate` confirms the server-side rules.

Run Task 4 tests, lint, and typecheck. Expected: PASS.

- [ ] **Step 4: Commit Google boundaries**

```bash
git add src/lib/google src/app/api/google src/app/api/folders src/components/google-picker.tsx tests/fakes/google.ts
git commit -m "feat: add Google API and Picker boundaries"
```

### Task 5: Sheet-Native Config Repository And Per-Request Access Policy

**Files:**

- Create: `src/lib/config/schema.ts`, `src/lib/config/repository.ts`
- Create: `src/lib/access/policy.ts`
- Test: `src/lib/config/schema.test.ts`, `repository.test.ts`, `src/lib/access/policy.test.ts`

- [ ] **Step 1: Write failing config parse/write tests**

Use the exact schema from the approved spec:

```ts
const parsed = parseAppConfig({
  settings: [
    ["schemaVersion", "1"],
    ["setupState", "ready"],
    ["month", "2026-07"],
    ["ownerEmail", "Manager@Blended-Asia.com"],
    ["templateVersion", "1"],
  ],
  statuses: [
    ["code", "labelEn", "sheetValue"],
    ["office", "Office", "出社"],
    ["absent", "Absent", "欠勤"],
  ],
  members: [
    ["displayName", "email", "sheetId", "sheetTitle", "protectionId", "permissionId", "setupStatus"],
    ["Linh", "Employee@Blended-Asia.com", "123", "Linh", "456", "789", "ready"],
  ],
});

expect(parsed.ownerEmail).toBe("manager@blended-asia.com");
expect(parsed.members[0].email).toBe("employee@blended-asia.com");
expect(parsed.members[0].sheetId).toBe("123");
```

Assert rejection of unknown schema versions, duplicate normalized emails, duplicate sheet IDs, invalid setup states, missing headers, and blank rows terminating each variable-length table. Run tests and expect FAIL because modules do not exist.

- [ ] **Step 2: Implement fixed-range config read/write**

`ConfigRepository.read(fileId)` reads `__APP_CONFIG!A1:B5`, `D1:F`, and `H1:N`; it stops status/member parsing at the first fully blank row. `initialize` creates/hides the sheet, writes version-1 tables, protects it owner-only, and sets:

```ts
{
  attendanceApp: "v1",
  attendanceSetupState: "pending",
  attendanceMonth: month,
}
```

`updateMemberProgress` and `updateSetupState` patch only the affected config range and app properties. Numeric Google IDs are converted to strings before writing.

- [ ] **Step 3: Implement manager/employee authorization with negative proof**

Define:

```ts
export type FileRole =
  | { kind: "manager"; email: string }
  | { kind: "employee"; email: string; sheetId: string; sheetTitle: string };

export async function authorizeFile(
  dependencies: AccessDependencies,
  request: { fileId: string; actorEmail: string; requestedSheetId?: string },
): Promise<FileRole>;
```

The manager path requires current Drive `ownedByMe=true` and current owner email equal to the actor. The employee path requires a valid config mapping to exactly one existing sheet and, when supplied, `requestedSheetId` equal to that mapping. Missing config/protection returns `NeedsSetupError`/`NeedsRepairError`; mismatched employee sheet returns `ForbiddenError` without disclosing the other employee's title.

Run all Task 5 tests. Include a negative assertion that employee A requesting employee B's sheet ID throws `ForbiddenError`. Expected: PASS.

- [ ] **Step 4: Commit config and access policy**

```bash
git add src/lib/config src/lib/access
git commit -m "feat: add sheet-native access policy"
```

### Task 6: Monthly Sheet Template And Retryable Create Service

**Files:**

- Create: `src/lib/workbook/contract.ts`, `src/lib/workbook/template.ts`
- Create: `src/lib/files/schemas.ts`, `src/lib/files/setup-service.ts`
- Create: `src/app/api/files/create/route.ts`
- Test: `src/lib/workbook/template.test.ts`, `src/lib/files/setup-service.test.ts`, `src/app/api/files/create/route.test.ts`
- Fixtures: `tests/fakes/file-dependencies.ts`

- [ ] **Step 1: Write failing template contract tests**

For July 2026 assert 31 rows beginning at row 4; column A contains each calendar date, column B displays weekday, column C increments Monday-Friday and is blank Saturday/Sunday, D uses the configured status enum, H contains the `=F-G-E` row formula on business days, and I is notes. Assert exactly 36 work columns J:AS and these headers:

```ts
expect(template.hourMerges.at(0)).toEqual({ range: "J2:K2", value: 6 });
expect(template.hourMerges.at(-1)).toEqual({ range: "AR2:AS2", value: 23 });
expect(template.minuteHeaders.slice(0, 4)).toEqual([0, 30, 0, 30]);
expect(template.minuteHeaders).toHaveLength(36);
expect(template.frozenPane).toEqual({ rows: 3, columns: 2 });
```

Assert employee tabs use the trimmed display name, and reject empty, duplicate-normalized, longer-than-100-character, or `: \\ / ? * [ ]` titles. Run tests and expect FAIL.

- [ ] **Step 2: Implement deterministic Sheets API template requests**

`buildEmployeeSheetPlan({ sheetId, month })` produces value, merge, format, validation, and freeze requests without calling Google. It writes Japanese headers only in the sheet contract, leaves attendance input cells blank, fills formulas rather than calculated work values, applies the status list validation to business-day D cells, and formats decimal-hour E:H cells without converting them to Excel time fractions.

`buildConfigSheetPlan` owns only reserved config coordinates. All batch requests refer to numeric sheet IDs; titles are display values, not identity keys.

- [ ] **Step 3: Write failing create-service orchestration tests**

Given two unique members, assert this ordered observable sequence:

```ts
expect(events).toEqual([
  "validate-folder:folder-1",
  "create-drive-file:202607勤怠管理表:folder-1",
  "set-app-properties:pending",
  "create-config-and-employee-sheets",
  "protect-config-and-employee-sheets",
  "invite:employee-a@blended-asia.com",
  "invite:employee-b@blended-asia.com",
  "set-app-properties:ready",
]);
```

Assert duplicate emails fail before any Google mutation. Assert an invitation failure retains `fileId`, `folder`, setup state, completed member IDs, and failed member status; retry does not recreate the file/tab/protection or re-invite completed members.

- [ ] **Step 4: Implement create service and authenticated Route Handler**

Validate with Zod:

```ts
export const createFileInputSchema = z.object({
  fileName: z.string().trim().min(1).refine((name) => name.includes("勤怠管理表")),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  destinationFolder: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  members: z.array(z.object({
    displayName: z.string().trim().min(1),
    email: z.email().transform((value) => value.toLowerCase()),
  })).min(1),
});
```

At least one valid member is required when creating a monthly attendance file. `SetupService.create` revalidates the folder immediately before Drive creation, uses the current OAuth identity, records `pending`, creates sheets/config/protections, serializes invitations, and returns HTTP 201 for ready or HTTP 207 with file/folder/member progress for retained partial setup. The route calls `requireGoogleSession`; client-supplied owner email is never accepted.

Run Task 6 tests, lint, and typecheck. Expected: PASS.

- [ ] **Step 5: Commit monthly creation**

```bash
git add src/lib/workbook src/lib/files/schemas.ts src/lib/files/setup-service.ts src/app/api/files/create tests/fakes/file-dependencies.ts
git commit -m "feat: create monthly attendance sheets"
```

### Task 7: XLSX Inspection, Mapping, Conversion, And Partial Resume

**Files:**

- Create: `src/lib/workbook/xlsx-inspector.ts`
- Create: `src/lib/files/import-service.ts`
- Create: `src/app/api/files/import/inspect/route.ts`, `src/app/api/files/import/route.ts`
- Test: `src/lib/workbook/xlsx-inspector.test.ts`, `src/lib/files/import-service.test.ts`
- Create: `tests/fixtures/workbook.ts`

- [ ] **Step 1: Generate a deterministic in-memory workbook fixture and failing inspector tests**

`tests/fixtures/workbook.ts` uses ExcelJS to create buffers, not repository binary fixtures. Its valid workbook has two visible employee sheets, merged J2:K2 through AR2:AS2, 6–23 hour headers, alternating 0/30 minute headers, D3:I3 Japanese headers, July 2026 date rows from row 4, and H formulas. The test asserts:

```ts
const result = await inspectXlsx(await buildAttendanceWorkbookBuffer());
expect(result).toEqual({
  sheets: [
    { title: "Employee A", rowCount: 31, month: "2026-07" },
    { title: "Employee B", rowCount: 31, month: "2026-07" },
  ],
});
```

Add mutations that independently break D:I headers, one merge, one minute header, selected month, and H formula compatibility. Assert each error includes sheet title and stable check code. Assert an existing `__APP_CONFIG` is ignored rather than trusted; any other visible auxiliary sheet blocks import. Run the inspector test and expect FAIL.

- [ ] **Step 2: Implement bounded XLSX parsing and explicit recognition results**

Accept only a buffer no larger than `20 * 1024 * 1024` bytes with ZIP/XLSX content; reject encrypted, corrupt, macro-enabled, and non-XLSX input with safe English messages. Define:

```ts
export type WorkbookCheckCode =
  | "unsupported-file"
  | "file-too-large"
  | "missing-headers"
  | "invalid-hour-merges"
  | "invalid-minute-headers"
  | "month-mismatch"
  | "invalid-work-formula"
  | "unsupported-sheet";

export interface WorkbookInspection {
  sheets: Array<{ title: string; rowCount: number; month: string }>;
}
```

Inspect cell values/formulas and merges without rewriting the buffer. Date rows may be Excel serials or JavaScript dates but must all resolve to the manager-selected month during final validation. H is reconcilable only when blank or equivalent to the row's `F-G-E`; arbitrary formulas block import.

- [ ] **Step 3: Write failing import orchestration and recovery tests**

Assert inspection performs no Drive/Sheets calls. On Save, assert this order: validate input and every sheet mapping, revalidate folder, convert original bytes with exactly one parent, mark pending, replace untrusted config, reconcile mapped sheets/protections, invite unique emails sequentially, mark ready. A failure after conversion must return HTTP 207 data shaped as:

```ts
{
  fileId: "converted-file-1",
  folder: { id: "folder-1", name: "Attendance 2026" },
  setupState: "needs-repair",
  retryable: true,
  members: [
    { email: "employee-a@blended-asia.com", setupStatus: "ready" },
    { email: "employee-b@blended-asia.com", setupStatus: "invite-failed" },
  ],
}
```

Retry must reuse `converted-file-1` and must not upload the workbook again.

- [ ] **Step 4: Implement multipart routes and import service**

`POST /api/files/import/inspect` requires a session, checks `Content-Length` when present, reads the `file` form field, enforces 20 MB after buffering, and returns recognized sheet metadata without Google mutation. `POST /api/files/import` accepts the file plus JSON fields for name/month/folder/mappings, re-runs all validation against the original bytes, then calls the import service. Each visible employee sheet requires one unique normalized email; title is fixed from the workbook.

The original upload buffer is passed unchanged to Drive conversion. After conversion, the service obtains numeric sheet IDs, replaces any uploaded `__APP_CONFIG`, applies current protections/config, and stores the selected month. Return 201 ready or 207 retained partial state; safe validation failures use 400 and make no Drive file.

Run Task 7 tests, lint, and typecheck. Expected: PASS.

- [ ] **Step 5: Commit import support**

```bash
git add src/lib/workbook/xlsx-inspector.ts src/lib/files/import-service.ts src/app/api/files/import tests/fixtures/workbook.ts
git commit -m "feat: import attendance workbooks"
```

### Task 8: Folder-Scoped Discovery, Role-Aware Dashboard, And Legacy Setup

**Files:**

- Create: `src/lib/discovery/file-discovery.ts`, `src/lib/dashboard/folder-preference.ts`
- Create: `src/app/api/dashboard/route.ts`
- Create: `src/app/(authenticated)/dashboard/page.tsx`, `src/app/(authenticated)/dashboard/dashboard-client.tsx`
- Create: `src/app/api/files/[fileId]/setup/route.ts`
- Create: `src/app/(authenticated)/files/[fileId]/setup/page.tsx`, `src/app/(authenticated)/files/[fileId]/setup/legacy-setup-wizard.tsx`
- Modify: `src/lib/files/setup-service.ts`
- Modify: `src/components/google-picker.tsx`
- Test: `src/lib/discovery/file-discovery.test.ts`, `src/lib/dashboard/folder-preference.test.ts`, `src/app/(authenticated)/dashboard/dashboard-client.test.tsx`, `src/lib/files/setup-service.test.ts`

- [ ] **Step 1: Write failing manager and employee discovery tests**

Manager assertions:

```ts
const dashboard = await discovery.load({ actorEmail: "manager@blended-asia.com", folderId: "folder-1" });
expect(dashboard.managed.map((file) => file.id)).toEqual(["direct-ready", "direct-legacy"]);
expect(dashboard.managed.find((file) => file.id === "direct-legacy")?.setupState).toBe("needs-setup");
expect(dashboard.managed.map((file) => file.id)).not.toContain("nested-file");
expect(dashboard.managed.map((file) => file.id)).not.toContain("wrong-name");
```

Employee assertions require `sharedWithMe`, case-insensitive owner suffix `@blended-asia.com`, case-sensitive filename substring, and exactly one valid config mapping to the actor. Assert a matching shared file with zero/two mappings, missing sheet, or owner outside the domain is excluded. A user can receive both managed and employee results.

- [ ] **Step 2: Implement server discovery and browser-only folder preference**

`FileDiscovery.load` always computes employee results. It computes manager results only after `validateManagerFolder(folderId)` succeeds. It reads config for candidates sequentially in v1 so one failed file becomes a card-level error rather than failing the whole dashboard.

`folder-preference.ts` owns exactly this non-authoritative local-storage contract:

```ts
export const folderPreferenceKey = (email: string) =>
  `attendance.dashboardFolder:${email.trim().toLowerCase()}`;

export interface FolderPreference { id: string; name: string }
```

Malformed JSON is removed. Changing folder replaces the stored preference and never moves files. A 404/403/422 folder response clears the preference only after showing `Folder unavailable`; there is no all-Drive manager fallback.

- [ ] **Step 3: Implement dashboard API and English UI states**

`GET /api/dashboard?folderId=...` requires a session, ignores any client email, and returns `{ managed, timesheets, folderError? }`. The page shows `Managed attendance files` and `My timesheets`. Before a manager folder is selected, show `Select dashboard folder`; after selection show folder name and `Change folder`. Cards show file name, month, owner, member count/mapped tab, modified time, setup state, and permitted actions only.

Ready manager cards expose Open, Manage members, and Open in Google Sheets. Employee cards link directly to their mapped numeric sheet ID. Needs-setup files remain read-only until explicit spreadsheet Picker selection.

- [ ] **Step 4: Implement explicit legacy-file setup with same-file proof**

The legacy setup wizard opens Picker in spreadsheet mode. The server requires the picked ID to equal the route `fileId`, rechecks current ownership/name/parent folder, reads all non-config sheet IDs/titles, and asks for one display name/email mapping per managed employee sheet. On Save, `SetupService.configureExisting` creates current config, shares, and protects without recreating employee sheets.

Tests assert no mutation before Picker confirmation, picked-ID mismatch returns 403, duplicate mappings return 400, and retry resumes partial member setup. Run all Task 8 tests. Expected: PASS.

- [ ] **Step 5: Commit discovery and dashboard**

```bash
git add src/lib/discovery src/lib/dashboard src/app/api/dashboard 'src/app/(authenticated)/dashboard' src/app/api/files/*/setup 'src/app/(authenticated)/files'/*/setup src/components/google-picker.tsx src/lib/files/setup-service.test.ts
git commit -m "feat: add folder-scoped dashboard"
```

### Task 9: Create And Import Manager Wizards

**Files:**

- Create: `src/components/member-rows.tsx`
- Create: `src/app/(authenticated)/files/new/page.tsx`, `src/app/(authenticated)/files/new/new-file-wizard.tsx`
- Create: `src/app/(authenticated)/files/import/page.tsx`, `src/app/(authenticated)/files/import/import-wizard.tsx`
- Test: `src/components/member-rows.test.tsx`, `src/app/(authenticated)/files/new/new-file-wizard.test.tsx`, `src/app/(authenticated)/files/import/import-wizard.test.tsx`

- [ ] **Step 1: Write failing create-wizard interaction tests**

Render with a saved folder and assert stage order: File/month/folder, Members, Review/create. Verify destination defaults to the active dashboard folder, `Change folder` uses Picker, member rows can be added, and client validation shows English errors for missing marker, invalid month/email, duplicate normalized email, duplicate/illegal tab name, and unavailable folder.

```tsx
await user.type(screen.getByLabelText("File name"), "202607勤怠管理表");
await user.type(screen.getByLabelText("Employee name 1"), "Employee A");
await user.type(screen.getByLabelText("Employee email 1"), "employee-a@blended-asia.com");
await user.click(screen.getByRole("button", { name: "Review" }));
expect(screen.getByText("Attendance 2026")).toBeVisible();
```

Assert double submission is disabled, 201 navigates to the file/dashboard, and 207 switches the remembered folder and shows retained file plus `Resume setup`.

- [ ] **Step 2: Implement accessible reusable member rows and create wizard**

Each input has an explicit indexed label and inline error association. Member deletion is allowed only before file creation; it is not the product member-removal operation. Serialize only trimmed names and normalized emails. Use one reducer/state machine so Back preserves values. The Review page displays filename, month, destination, members, and an explicit Create button; no Google mutation occurs before that button.

- [ ] **Step 3: Write failing import-wizard interaction tests**

Assert `.xlsx` accept type and 20 MB message; upload triggers inspect only; detected sheet titles render before mappings; each sheet requires unique email; output name is an editable base-name suggestion; month is never inferred from the name; destination defaults to active folder. A structural inspector error lists the exact sheet/check and prevents Save.

On final Save, assert the same file object is resubmitted with confirmed metadata. Assert 201/207 behaviors match Task 7 and activate the destination folder immediately after Drive conversion.

- [ ] **Step 4: Implement import wizard and shared API error presentation**

Keep the selected `File` in component memory, not local storage. Use `FormData` for inspection and final save. Map stable API error codes to English messages, retain all wizard fields on failure, and provide Retry/Re-authenticate as appropriate. Do not render raw Google API messages.

Run Task 9 tests, lint, and typecheck. Expected: PASS.

- [ ] **Step 5: Commit manager wizards**

```bash
git add src/components/member-rows.tsx src/components/member-rows.test.tsx 'src/app/(authenticated)/files/new' 'src/app/(authenticated)/files/import'
git commit -m "feat: add create and import wizards"
```

### Task 10: Add-Member Management Flow

**Files:**

- Create: `src/lib/files/member-service.ts`
- Create: `src/app/api/files/[fileId]/members/route.ts`
- Create: `src/app/(authenticated)/files/[fileId]/members/page.tsx`, `src/app/(authenticated)/files/[fileId]/members/member-form.tsx`
- Test: `src/lib/files/member-service.test.ts`, `src/app/api/files/[fileId]/members/route.test.ts`, `src/app/(authenticated)/files/[fileId]/members/member-form.test.tsx`

- [ ] **Step 1: Write failing owner-only and idempotency tests**

Assert a current owner can add one normalized email and receives a new employee sheet/config row/protection/writer permission. Assert an employee receives 403 before any mutation. Assert existing member email or title returns 409. If invitation fails after sheet/protection creation, the response retains IDs and Retry invites only the failed email.

```ts
await expect(service.addMember({
  fileId: "file-1",
  actorEmail: "employee@blended-asia.com",
  displayName: "New Person",
  email: "new@blended-asia.com",
})).rejects.toMatchObject({ code: "forbidden" });
expect(fakeGoogle.events).toEqual([]);
```

- [ ] **Step 2: Implement add-member service and API**

Authorize manager from current Drive ownership and valid config. Reuse the current file month/template version. Create one employee tab, template, protection, config row, and serialized permission. Store `pending`, `ready`, or `invite-failed` progress. `POST` accepts only display name/email; file ID comes from route, owner comes from session. Do not implement DELETE or permission revocation.

- [ ] **Step 3: Implement English member page and retry UI**

Display current members and setup status from protected config. The form has Name, Google Workspace email, Add member, and Retry invitation actions. Confirm successful addition without leaving the page. A manager can open the new tab; no Remove action exists.

Run Task 10 tests. Expected: PASS.

- [ ] **Step 4: Commit member management**

```bash
git add src/lib/files/member-service.ts src/lib/files/member-service.test.ts src/app/api/files/*/members 'src/app/(authenticated)/files'/*/members
git commit -m "feat: add attendance members"
```

### Task 11: Authorized Attendance Read And Exact Dirty-Range Save

**Files:**

- Create: `src/lib/attendance/service.ts`
- Create: `src/app/api/files/[fileId]/attendance/[sheetId]/route.ts`
- Test: `src/lib/attendance/service.test.ts`, `src/app/api/files/[fileId]/attendance/[sheetId]/route.test.ts`

- [ ] **Step 1: Write failing read and authorization tests**

For a mapped employee, GET must return only the mapped sheet's month/day model, configured status enum, numeric sheet ID/title, and dates in the configured month. A manager may address any member sheet in their owned file. Employee A addressing employee B sheet must return 403 without reading attendance values. Invalid/missing config returns needs-setup/repair, not fallback.

- [ ] **Step 2: Write failing exact-save and conflict-disclosure tests**

Given baseline and new note only, assert one write to `I7`. Given work text at 09:00 only, assert one write to the mapped J:AS column. Given clock-in, break, and note changes, assert only E7/G7/I7; H7 is never written. Re-read dirty cells immediately before update and test same-cell divergence:

```ts
expect(result.conflicts).toEqual([
  { range: "I7", baseline: "Old note", current: "Changed in Sheet" },
]);
expect(fakeSheets.valueUpdates).toEqual([
  { range: "'Employee A'!I7", value: "Web note wins" },
]);
```

Different-cell changes do not create a conflict or cause a row-wide write.

- [ ] **Step 3: Implement date-to-row resolution and allowed-range enforcement**

GET reads A4:AS for the configured month's actual day count and converts raw sheet values into `AttendanceDay`. Infer `lunchBreak=true` only when break is 1 and both lunch slots are empty; the user may toggle it explicitly in the draft.

POST accepts `{ date, patches }`, not arbitrary A1 ranges. Resolve the row from column A server-side, derive allowed cells from field keys, reject column A/B/C/H/config or another sheet, validate the reconstructed day, compare current dirty cells with client baselines, then issue the smallest `values.batchUpdate`. Return recalculated H plus conflict metadata. Last writer wins as approved, but the response must disclose conflicts.

- [ ] **Step 4: Implement safe Route Handler responses**

GET/POST require `requireGoogleSession` and `authorizeFile` before sheet values. Map 400 validation, 401 session, 403 access, 409 changed structure, 422 needs repair, and 502 Google boundary errors to stable codes/English messages. Preserve client dirty data by never redirecting a failed POST response.

Run Task 11 tests, lint, and typecheck. Expected: PASS.

- [ ] **Step 5: Commit attendance API**

```bash
git add src/lib/attendance/service.ts src/lib/attendance/service.test.ts src/app/api/files/*/attendance
git commit -m "feat: add authorized attendance saves"
```

### Task 12: Synchronized Timeline And Work-Block Attendance Editor

**Files:**

- Create: `src/app/(authenticated)/files/[fileId]/attendance/[sheetId]/page.tsx`, `attendance-editor.tsx`
- Create: `src/components/day-summary.tsx`, `src/components/timeline-editor.tsx`, `src/components/work-block-form.tsx`
- Test: corresponding `*.test.tsx` files beside each component/page

- [ ] **Step 1: Write failing combined-editor interaction tests**

Load one day and assert English labels, 24-hour times, configured Office/Absent options, calculated work hours, notes, lunch checkbox, timeline, work-block form, dirty indicator, and Save button. Cover this synchronization:

```tsx
await user.selectOptions(screen.getByLabelText("Start"), "09:00");
await user.selectOptions(screen.getByLabelText("End"), "10:00");
await user.type(screen.getByLabelText("Work description"), "Client report");
await user.click(screen.getByRole("button", { name: "Apply work block" }));
expect(screen.getByLabelText("09:00 work")).toHaveValue("Client report");
expect(screen.getByLabelText("09:30 work")).toHaveValue("Client report");
expect(screen.getByLabelText("10:00 work")).toHaveValue("");
```

Editing a timeline cell must update the in-memory day used by the block form/save. Overwriting non-empty slots shows a confirmation listing the affected times before applying.

- [ ] **Step 2: Write failing lunch, notes, calculation, and retry tests**

Checking `Lunch break · 12:00–13:00` sets break to 1, disables/clears 12:00 and 12:30 in the draft, and makes a crossing block skip them. The clear reaches Sheets only after explicit Save. Unchecking re-enables the slots and makes break editable. With 08:00–17:30 and one-hour break, show 8.5 hours. Invalid time/break/status blocks Save with English inline errors.

Assert Save sends only `diffDay` patches, clears dirty state only on success, keeps edits on failure, offers Retry/Re-authenticate, and displays last-writer conflict disclosure without undoing the saved value.

- [ ] **Step 3: Implement one-reducer editor and focused components**

`AttendanceEditor` owns `{ baseline, draft, selectedDate, saveState }` in one reducer. `DaySummary` edits D:G/I domain fields and derives H. `TimelineEditor` renders 36 labeled inputs. `WorkBlockForm` only produces domain commands and overwrite previews. No component calls Google directly; the editor uses the attendance Route Handler.

Add month/day navigation, current-day preference when present, weekend labels, unsaved-change navigation warning, keyboard focus styles, live-region save status, and mobile stacking while preserving a desktop 36-slot scroll region.

- [ ] **Step 4: Run focused UI and full component proof**

Run:

```bash
docker compose run --rm test npm test -- src/components 'src/app/(authenticated)/files'
docker compose run --rm test npm run lint
docker compose run --rm test npm run typecheck
```

Expected: all tests PASS with no React act, accessibility-label, lint, or TypeScript errors.

- [ ] **Step 5: Commit the editor**

```bash
git add 'src/app/(authenticated)/files'/*/attendance src/components/day-summary.tsx src/components/day-summary.test.tsx src/components/timeline-editor.tsx src/components/timeline-editor.test.tsx src/components/work-block-form.tsx src/components/work-block-form.test.tsx
git commit -m "feat: add attendance editor"
```

### Task 13: Browser Proof, Security Boundaries, Documentation, And Final Docker Verification

**Files:**

- Create: `playwright.config.ts`, `tests/e2e/auth.setup.ts`, `tests/e2e/dashboard.spec.ts`, `create-import.spec.ts`, `attendance.spec.ts`, `authorization.spec.ts`
- Create: `src/lib/testing/runtime-guard.ts`, `src/lib/testing/fake-google-store.ts`, `src/app/api/e2e/reset/route.ts`
- Test: `src/lib/testing/runtime-guard.test.ts`, `tests/reference-workbook.test.ts`
- Modify: `README.md`
- Create: `.env.e2e.example`
- Create: `docs/product/attendance.md`, `docs/runbooks/google-cloud-setup.md`

- [ ] **Step 1: Write and prove the production test-bypass guard before adding the adapter**

Define an injectable guard and test both directions:

```ts
expect(resolveTestMode({ NODE_ENV: "test", E2E_TEST_MODE: "1" })).toBe(true);
expect(resolveTestMode({ NODE_ENV: "development", E2E_TEST_MODE: "1" })).toBe(true);
expect(() => resolveTestMode({ NODE_ENV: "production", E2E_TEST_MODE: "1" }))
  .toThrow("E2E_TEST_MODE is forbidden in production");
expect(resolveTestMode({ NODE_ENV: "production" })).toBe(false);
```

Run the test before implementation and expect FAIL; implement the minimum guard and expect PASS. Production auth/gateway factories must call this guard before considering test adapters.

- [ ] **Step 2: Add a deterministic non-production session/Google adapter**

Only when `E2E_TEST_MODE=1` and `NODE_ENV` is `test` or `development`, use an in-memory store on a stable `globalThis` key and an `e2e-user` cookie for deterministic identities. `/api/e2e/reset` requires `E2E_TEST_MODE=1` and `X-E2E-Secret` equal to an environment secret, seeds owned/shared folders/files/configs, and otherwise returns 404. The adapter implements the same `DriveGateway`, `SheetsGateway`, and config interfaces; product services and authorization remain unchanged.

Add `.env.e2e.example` with non-secret sample values and keep `.env.e2e` ignored. Add a test proving the reset route is unreachable when test mode is false.

- [ ] **Step 3: Implement Playwright workflows against the real UI/API**

Configure one Chromium project with `baseURL: "http://127.0.0.1:3100"` and this non-production web-server contract: `E2E_TEST_MODE=1 E2E_TEST_SECRET=local-playwright-only npm run dev -- --hostname 0.0.0.0 --port 3100`. Set `reuseExistingServer: false`. Tests must cover:

- manager selects/changes a folder and sees only direct matching children;
- invalid remembered folder shows `Folder unavailable` without all-Drive fallback;
- manager creates a file, imports an in-memory XLSX buffer, and sees the new/partial file in the destination folder;
- manager explicitly Picker-confirms a legacy file before setup (mock only the external Picker callback, not the app API);
- employee sees only shared domain/name/mapped files and opens the mapped numeric sheet;
- employee uses block/timeline/lunch/notes/status/save/retry;
- employee requests another sheet URL/API and receives 403;
- production-mode test bypass remains unavailable.

Use semantic roles/labels and assert visible English copy. Run `docker compose run --rm test npm run test:e2e`; expected: all Chromium tests PASS.

- [ ] **Step 4: Add optional proof against the supplied reference workbook**

`tests/reference-workbook.test.ts` runs only when `REFERENCE_XLSX_PATH` is set. It reads that file through `inspectXlsx`, asserts the four observed employee sheet titles, July 2026 month, D:I headers, J:AS time grid, and reconcilable H formulas. It never writes the workbook.

Run inside the test container with:

```bash
docker compose run --rm --env REFERENCE_XLSX_PATH=/app/202607勤怠管理表.xlsx test npm test -- tests/reference-workbook.test.ts
```

Expected: PASS for all four sheets. If the file is unavailable in another environment, report this proof as unattempted rather than silently replacing the fixture.

- [ ] **Step 5: Write product, Docker, and Google Cloud runbooks**

`README.md` must include prerequisites, copying `.env.example` to `.env`, Docker build/test/start/stop commands, health URL, and the fact that application keys live in ignored `.env`. `docs/product/attendance.md` distills the approved roles, discovery, workbook, lunch, status, notes, and access behavior without replacing the spec.

`docs/runbooks/google-cloud-setup.md` must state exact operator-owned prerequisites: enable Google Sheets API, Google Drive API, and Google Picker API; configure OAuth consent/test users; declare identity/Sheets/`drive.file`/`drive.metadata.readonly`; register `http://localhost:3000/api/auth/callback/google`; configure authorized JavaScript origin; create a referrer-restricted Picker API key and project number; fill `.env`; and note organization approval/verification risk. Include a live smoke checklist for manager create/share/protection, employee discovery/mapped save, folder parent verification, and revoked-token re-consent. Do not claim those external steps were performed.

- [ ] **Step 6: Run the complete local and Docker verification matrix**

Run each command separately and record observed output in this plan's Validation section:

```bash
docker compose build test
docker compose run --rm test npm run lint
docker compose run --rm test npm run typecheck
docker compose run --rm test npm test
docker compose run --rm test npm run test:e2e
docker compose build app
docker compose up --detach app
curl --fail http://localhost:3000/api/health
docker compose down
```

Expected: builds exit 0, lint/typecheck have no errors, all tests pass, health returns `{"status":"ok"}`, app service becomes healthy, and only this Compose project's resources are stopped. Inspect `docker compose config` to confirm secrets are referenced through env files and are not baked into image layers.

- [ ] **Step 7: Record live limits, update plan result, and commit**

If valid Google credentials/test accounts are available, run the runbook live smoke and record file IDs without tokens/emails beyond approved test data. Otherwise explicitly record live OAuth/Drive/Sheets proof as blocked by missing external credentials while keeping deterministic proof complete.

```bash
git add .env.e2e.example playwright.config.ts src/lib/testing src/app/api/e2e tests README.md docs/product/attendance.md docs/runbooks/google-cloud-setup.md docs/plans/active/2026-08-28-google-sheets-attendance-app.md
git commit -m "test: verify attendance application"
```

Do not move this plan to `docs/plans/completed/` until every locally available validation is recorded, the observable application outcome exists, and remaining live external proof is explicitly separated from completed local proof.

## Decisions

- 2026-08-28: Use one active repository plan because implementation spans interdependent authentication, Drive, Sheets, workbook, UI, and validation work and must remain resumable.
- 2026-08-28: Build and test through Docker first; host Node 22 is not the validation owner. Pin Node 24 LTS and package versions in the image/lockfile.
- 2026-08-28: Use Auth.js JWT sessions without an adapter/database; isolate beta APIs and keep refresh tokens only inside encrypted server-managed session cookies.
- 2026-08-28: Use Route Handlers as a backend-for-frontend and inject gateway interfaces into services so tests do not require Google credentials.
- 2026-08-28: Use native CSS and small focused React components; no component framework is needed for the approved UI.
- 2026-08-28: Use ExcelJS only for inspection/fixture generation; upload original XLSX bytes unchanged to Drive for conversion.
- 2026-08-28: The E2E adapter is a non-production proof seam guarded mechanically against production activation; it does not create an application database or alternate authorization policy.
- 2026-08-28: Mirror the reference workbook's business-day sequence as Monday–Friday only; no holiday calendar was supplied or added.
- 2026-08-28: Reconstruct the lunch checkbox on load from one break hour plus empty 12:00/12:30 work cells because the approved sheet contract has no separate persisted lunch flag.

## Spec Coverage Self-Review

| Approved requirement | Planned proof owner |
| --- | --- |
| Next.js, Docker-first build, `.env`, English UI | Tasks 1 and 13 |
| Google OAuth, refresh, required scopes, no DB | Task 3 |
| Google Picker folder selection and direct-parent manager dashboard | Tasks 4 and 8 |
| Employee shared/domain/name/exact mapping discovery | Tasks 5 and 8 |
| Manager is current owner, rechecked per mutation | Tasks 5, 6, 7, 10, and 11 |
| New file name/month/manual emails/one tab each | Tasks 6 and 9 |
| XLSX inspect/map/convert/new file/20 MB/partial resume | Tasks 7 and 9 |
| Protected config and employee tabs, sequential invites | Tasks 5–7 and 10 |
| Status enum, decimal time, formulas, notes | Tasks 2, 5, 6, 11, and 12 |
| 30-minute timeline plus half-open work blocks | Tasks 2 and 12 |
| Lunch 12:00–13:00 and automatic work hours | Tasks 2 and 12 |
| Exact dirty cells, authorization, last-writer disclosure | Task 11 |
| Add member only; no remove/revoke | Task 10 |
| Deterministic, browser, Docker, reference, and optional live proof | Task 13 |

Self-review checks before handoff:

- [x] Scanned for unresolved markers and vague test-only instructions; none remain.
- [x] Verified every file in the module map has a creating/modifying task.
- [x] Verified later types and function names match their defining tasks.
- [x] Verified no task adds Shared Drive, recursive folder, Admin SDK, database, member removal, or deployment scope.

## Validation

Task 1 focused proof: RED `docker compose run --rm test npm test -- src/app/api/health/route.test.ts` failed because `./route` did not exist; GREEN passed 1/1 after the route was added.
Task 1 Docker proof: `docker compose build test`; Docker lint, typecheck, and test (1/1); `docker compose build app`; and runtime `GET /api/health` returning `{"status":"ok"}` all passed.
Task 2 RED proof: focused attendance tests first failed because the requested domain modules did not exist; Fix Round 1 regressions then failed for a future configured status sheet value, an absent configured status mapping, and a negative fractional break.
Task 2 GREEN/full proof: `docker compose run --rm test npm test -- src/lib/attendance` passed 19/19; full Docker Vitest passed 20/20; Docker lint and typecheck passed; `git diff --check` passed. The domain was committed as `f4c1f47` and Fix Round 1 is recorded with its follow-up commit.
Task 3 RED/GREEN proof: Docker-focused tests first failed because `src/lib/auth/google-token.ts` and `session.ts` did not exist; the identity-preservation regression then failed until the successful refresh retained prior JWT claims and cleared its old refresh error. `docker compose run --rm test npm test -- src/lib/auth/google-token.test.ts src/lib/auth/session.test.ts` passed 10/10. The direct Auth.js session-callback assertion serializes normalized email and refresh error only, with neither provider access nor refresh token present; focused proof also injects the server JWT reader and verifies the generic no-store 401 mapping.
Task 3 full Docker proof: `docker compose run --rm test npm run lint`, `docker compose run --rm test npm run typecheck`, `docker compose run --rm test npm test` (30/30), and `docker compose build app` all passed. The build recognized the Auth.js route and Next 16 proxy. No live OAuth proof was attempted because external credentials and organization approval are not available.
Task 3 Fix Round 1 security proof: RED tests rejected the old refresh-error proxy authorization, insecure HTTPS-cookie selection, and public-path Auth.js evaluation. GREEN focused Docker proof passed 21/21 across authorization, proxy boundary, token, and session tests. It includes real `next-auth/jwt` encrypted JWT encode/getToken proof for HTTP and HTTPS cookie names/salts. Full Docker lint/typecheck, Vitest 41/41, production build, and `git diff --check` passed; the build reports `/` and `/login` as static and recognizes the Next 16 proxy.
Task 3 Fix Round 2 proxy proof: real exported-proxy RED integration tests returned 200 instead of redirecting protected requests because the beta.32 handler wrapper executed its supplied handler before a false `authorized` result. The direct `auth(request)` path now short-circuits public paths first and returns Auth.js’s authorization response, with a fail-closed fallback only for an unexpected null/undefined result. GREEN focused proxy/auth proof passed 23/23, including unauthenticated and encoded refresh-error redirects plus valid unexpired HTTPS-session continuation. Full Docker lint/typecheck, Vitest 46/46, production build, and `git diff --check` passed. Task 12's future focused-test path now quotes `src/app/(authenticated)/files`.
Repository-required checks: Task 1 `git diff --check` passed; remaining tasks retain their own required validation.
Live Google proof: Requires user-supplied credentials, enabled APIs, OAuth audience/callbacks, test accounts, and any organization approval.

## Result

Task 1 foundation completed in `f05f381` (`chore: scaffold Dockerized Next.js app`); Docker lint/typecheck, Vitest 1/1, production build, and readiness proof passed. Task 2 attendance domain completed in `f4c1f47` with Fix Round 1 configuration-driven status mapping and validation corrections; focused 19/19, full 20/20, Docker lint/typecheck, and diff checks passed. Task 3 adds encrypted Auth.js JWT Google OAuth sessions, identity-preserving refresh-token rotation, server-only token decoding, proxy protection, and English sign-in/sign-out controls; it was committed as `125a0ef` with focused 10/10 and full 30/30 Docker Vitest, Docker lint/typecheck, and Docker production build passing. Security Fix Round 1 rejects refresh-error browser sessions at the proxy, derives Auth.js secure-cookie selection from validated configured/request URLs, and avoids Auth.js evaluation for public pages while protected future UI paths inherit the route-group layout; focused 21/21 and full 41/41 Docker Vitest, Docker lint/typecheck, and Docker production build passed. Security Fix Round 2 removes Auth.js's beta.32 handler wrapper from protected requests: direct Auth.js request handling now enforces redirects for missing/refresh-error sessions while valid unexpired HTTPS sessions continue; focused 23/23 and full 46/46 Docker Vitest, Docker lint/typecheck, and Docker production build passed. Live OAuth remains unattempted pending external credentials and approval. Tasks 4–13 remain unchecked. Keep this section current during execution with verified outcome, observed commands, limitations, and recovery state. Move the file to `docs/plans/completed/` only after the completion standard in `docs/WORKFLOW.md` is satisfied.
