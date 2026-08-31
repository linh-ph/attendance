# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Authority Order

1. [`AGENTS.md`](AGENTS.md) — entry map and authority boundary. **Read it first.**
   Its `HARNESS:BEGIN/END` block is installed core; do not hand-edit it.
2. [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — request shape, planning, judgment,
   validation, and the completion standard.
3. [`docs/specs/2026-08-28-google-sheets-attendance-design.md`](docs/specs/2026-08-28-google-sheets-attendance-design.md)
   — the user-approved product/technical contract. Authority for **all**
   externally observable behavior.
4. [`docs/product/attendance.md`](docs/product/attendance.md) — the distilled
   living product document. Update it when behavior changes.
5. Code, tests, and runtime signals — executable truth.

This file summarizes what those establish; it does not override them.

## The Application

English-language Next.js app where **Google Sheets is the only datastore**. Each
signed-in user's own Google OAuth authority performs every Drive/Sheets call —
no service account, no database, no server-side user store.

**Stack:** Node 24.19 on Debian slim, Next.js 16.3.3 App Router, React 19.2.8,
TypeScript, Auth.js/NextAuth `5.0.0-beta.32`, `googleapis` 176, Google Picker,
ExcelJS 4.4.0, Zod 4.4.3, Vitest 4.1, Testing Library, Playwright 1.62, native
CSS (no UI framework, no CSS-in-JS).

### Commands

Docker-first. Local Node may not match the pinned 24.19, and `node_modules` is a
Compose volume — **do not run `npm` on the host.**

Compose defines one service, `app`, and the working tree is bind-mounted into
it, so `run` sees the current files without a rebuild.

```bash
cp .env.example .env                             # first run only; .env is gitignored
docker compose run --rm app npm run verify       # lint + typecheck + test + build
docker compose up --build app                    # http://localhost:3000
```

Readiness: `GET /api/health` (unauthenticated).

Playwright is the exception: `deps` carries no Chromium, so e2e runs against the
Dockerfile's `test` stage, which Compose no longer builds. It needs no `.env` —
`playwright.config.ts` starts its own dev server on port 3100 with its own
local-only environment.

```bash
docker build --target test -t attendance-e2e .
docker run --rm -v "$PWD:/app" -v /app/node_modules \
  attendance-e2e npm run test:e2e
```

Optional proof against the real supplied workbook:

```bash
docker compose run --rm \
  --env REFERENCE_XLSX_PATH=/app/202607勤怠管理表.xlsx \
  app npm test -- tests/reference-workbook.test.ts
```

Without that variable the suite skips instead of falsely passing.

**Capture exit status directly** (`; echo "EXIT=$?"`). A pipeline ending in
`grep`/`tail` reports *its* status, not npm's — that has already hidden a
failing gate once.

## Layout

```
src/lib/
  attendance/   model, time, slots, validation, range-mapper   ← pure domain
                service.ts                                     ← read + exact-range save
  workbook/     contract, template, xlsx-inspector             ← pure
  google/       types, errors, client, drive-gateway,
                sheets-gateway, picker                         ← only googleapis site
  config/       schema, repository                             ← __APP_CONFIG access
  access/       policy                                         ← per-request authorization
  files/        schemas, import-schemas, setup-{service,contracts,steps,
                monthly,legacy}, member-service, import-service ← orchestration
  discovery/    file-discovery                                 ← folder-scoped listing
  dashboard/    folder preference and compatibility cache adapter
  cache/        acknowledged IndexedDB cache, epochs, revisions, migrations
  directory/    browser-local member roster and Drive suggestions
  auth/         session, google-token, proxy, paths
  testing/      runtime-guard, fake-google-{store,state,seed,requests}
src/components/ app-shell, month-calendar, day-quick-preview, wizard-shell,
                sync-status, attendance editors and shared primitives
src/app/api/    health, auth, dashboard, folders/validate, google/picker-token,
                files/create, files/import[/inspect],
                files/[fileId]/{setup,members,attendance/[sheetId]}, e2e/reset
src/app/(authenticated)/  dashboard, timesheets, manage, members, more,
                          files/new, files/import,
                          files/[fileId]/{setup,members,attendance/[sheetId]}
tests/          e2e/ (Playwright), fakes/, fixtures/, reference-workbook.test.ts
```

### Boundaries to keep

- `attendance/*` (minus `service.ts`) and `workbook/*` are **pure**: no I/O, no
  Google types, no React.
- `googleapis` is imported by `src/lib/google/client.ts` and nowhere else.
  Services depend on the `DriveGateway`/`SheetsGateway` interfaces so tests
  inject fakes.
- Route handlers validate with Zod, resolve the session, authorize, delegate.
  No business rules there.
- Auth.js types stay inside `src/auth*.ts` and `src/lib/auth/` — the beta API
  drifts.
- Files stay under 800 lines (200–400 typical). Three modules were split once
  for exceeding this; don't grow them back.
- Import alias `@/` → `src/`.

## Invariants

Violating any of these is a product regression, not a style choice.

**Time and work hours**
- The sheet stores decimal hours: `8` = 08:00, `17.5` = 17:30. Convert at the
  boundary; never store display strings or Sheets time fractions.
- All clock, break, and work-block values are 30-minute increments.
- `workHours = clockOut − break − clockIn`; column H holds the **formula**
  `=F-G-E`, and H is **never written** by a save.
- Clock out > clock in; break not negative and not greater than the clocked
  duration; negative work hours rejected before Save.

**Lunch break (`Lunch break · 12:00–13:00`)**
- When checked: the 12:00 and 12:30 slots are reserved, work blocks skip them,
  break becomes `1`, work hours recalculate. Existing text there is cleared only
  as part of an explicitly confirmed Save.
- The server *infers* `lunchBreak` on read (break is `1` and both slots empty);
  the client keeps it as **explicit user intent** in the draft. Both are
  intended — see spec 3.3 and Task 11 Step 3.

**Workbook contract**
- A date, B weekday, C `営業日`, D `ステータス`, E `出勤`, F `退勤`, G `休憩`,
  H `労働時間`, I `備考`, J:AS 30-minute slots 06:00–23:30.
- H is blank on non-business days in the real workbook — accept blank *or* a
  formula equivalent to that row's `F-G-E`.
- Status is an enum written from configuration (`出社` / `欠勤`), never free
  text. UI copy is English; Japanese lives only in the sheet contract.
- `ATTENDANCE_NAME_MARKER` (`勤怠管理表`) has **one** definition. Create-name
  validation and discovery filtering must never diverge, or a manager can make a
  file the dashboard never finds.

**Shared Drives**
- Every `files.list` passes `supportsAllDrives` **and**
  `includeItemsFromAllDrives`, and every `files.get` passes `supportsAllDrives`.
  Without them Drive answers 404 for a shared-drive file rather than 403, which
  reads like a permission problem and is not one.
- Employee discovery scans by the attendance name marker, not `sharedWithMe`:
  that term is false for every shared-drive file.

**Writes**
- `ValuePatch.inputOption` defaults to `USER_ENTERED` so the `=F-G-E` contract
  works. Free text — column I notes and the J:AS slots — must be sent as `RAW`,
  or a note beginning with `=` becomes a formula and `2026-07` becomes a date.
- **Every `__APP_CONFIG` write is `RAW`.** This is not a preference: on the
  first real Google run, `USER_ENTERED` stored the month `2026-09` as the serial
  `46266`, which then failed to read back as `YYYY-MM` and made *every* file
  creation fail with a bare 502. Nothing in that sheet is ever a formula.
- Saves write the exact dirty A1 ranges, never whole rows or sheets.
- The client derives its dirty set by running the domain's own `diffDay`, so it
  cannot drift from the server's.

**`__APP_CONFIG`** (hidden, owner-protected, fixed coordinates)
- `A1:B5` settings, `D1:F` status enum, `H1:N` members — each table ends at the
  first fully blank row. Emails lowercase-normalized; Google numeric IDs stored
  as strings; member identity is the email; sheet **IDs** are stored so a rename
  is reconcilable.
- Member `setupStatus` is exactly `pending` | `ready` | `invite-failed`. One
  vocabulary, three writers — do not invent a fourth value.
- `ConfigMember.sheetId`/`sheetTitle`/`protectionId`/`permissionId` are nullable
  so partial setup is recordable. A stale mapping is `NeedsRepairError` — never
  a silent title-match fallback. A file with no configuration at all is opened
  on Google's own sharing instead (role `open`), and the person picks their tab.
- `protectionId` is now always `null`: **employee tabs are created open**. No
  setup path adds a protected range to one, and `authorizeFile` does not ask for
  one — the field stays in the schema so files created before this still read.
  Only the hidden `__APP_CONFIG` sheet keeps its owner-only protection.
- `__APP_CONFIG` is optional metadata, not a gate. Where it exists it still
  resolves a person straight to their tab; where it does not, the file is still
  fully usable.
- `initialize` refuses to overwrite an existing config sheet unless the caller
  passes `replaceExisting: true` (the import path's switch). `deleteSheet` is
  emitted on no other path.
- A schema change increments `schemaVersion` and needs an explicit reader.

**Authorization — Google's sharing is the boundary**

Since [`docs/decisions/2026-08-29-app-is-a-sheets-client.md`](docs/decisions/2026-08-29-app-is-a-sheets-client.md)
this app is a convenience client over Google Sheets, not an authorization layer
of its own. It was measured: every real workbook has `protectedRanges: []`, so
the old app-side check restricted only the people who used the app while the
same edit stayed one click away in Google Sheets.

Every server call still runs on the signed-in user's own Google credentials, so
nobody can do anything Google would refuse. On top of that:

1. the normalized email always comes from the verified server session, never
   from the client;
2. `authorizeFile` re-reads current Drive access on every request, never a
   cached role;
3. a file **with** a configuration keeps the mapped-employee restriction — an
   employee still cannot address another member's mapped sheet;
4. a file **without** a configuration returns role `open`: the requested tab is
   taken as given, because there is no mapping to restrict against and Google
   already decided the person may open the file;
5. `ownedByMe` is **not** required anywhere. Shared Drive files are owned by the
   organization and have no owner at all, and they are exactly the files people
   record hours in.

`authorizeFile` deliberately does **not** gate on the file-level `setupState`,
and a missing config sheet is **not** a refusal — only a configuration that
exists and is broken is (`NeedsRepairError`).

Cross-tab editing is out of scope: it is a Google Sheets sharing concern. If
per-tab isolation is ever wanted it comes from protected ranges on the file, not
from this app.

**Sheet creation vs. reconciliation**
- `buildEmployeeSheetPlan` emits an `updateSheetProperties` request that shrinks
  `rowCount` to the month's rows. Safe on a **freshly added** tab, destructive if
  replayed onto a populated one. Legacy setup and import adopt existing tabs and
  must never replay it.

**Secrets**
- Client secrets and refresh tokens never reach browser JS or a `NEXT_PUBLIC_`
  variable. Only `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` and
  `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER` are public.
- The Picker token is short-lived, returned with `Cache-Control: private,
  no-store`, held in component memory only.
- Browser storage never holds a token or an authorization result. It holds the
  selected folder ID/name in `localStorage`, and — in the `attendance-local`
  IndexedDB database — unsaved day drafts, the last loaded month per sheet, and
  recently opened sheets. Every record is keyed by normalized email so two
  accounts sharing a browser profile cannot read each other's, and none of it
  is authoritative: the server re-reads the sheet and re-authorizes every
  request. These records deliberately **survive sign-out** (an explicit product
  decision on 2026-08-29), so a shared machine keeps one user's work-hour
  drafts until that profile is cleared.
- A stored draft carries the baseline it was made against and is restored only
  onto an identical baseline. If the sheet moved on, the draft is dropped
  rather than replayed over newer data.
- A pasted Google Sheets link is a shortcut, never an access path: it resolves
  only against files the dashboard already listed, its `gid` is discarded so it
  cannot address an unmapped tab, and the destination route re-authorizes.
- `.env` and `.env.e2e` are gitignored; the `.example` files document names only.

**Recovery**
- Never auto-delete a created or converted Drive file as rollback. Persist
  per-member setup status before invitations and return IDs so the UI resumes.
- Invitations are serialized — never `Promise.all`.

## Test Mode

`resolveTestMode(env)` is the only gate to the deterministic Google adapter. It
**throws** when `E2E_TEST_MODE=1` under `NODE_ENV=production`, returns false in
production otherwise, and treats an unrecognized `NODE_ENV` as off. `/api/e2e/reset`
needs both the flag and `X-E2E-Secret`, and answers an empty 404 in every other
case rather than confirming it exists. Never weaken a product security check to
make a browser test pass.

Note: `client.ts` imports the adapter statically, so it ships in the production
bundle while being unreachable there. It is server-only and never reaches a
browser; making the import dynamic would turn the gateway factory async and
ripple through every route.

## Working Style

- Restate the outcome, inspect authority + implementation + existing proof, make
  the smallest coherent change, run focused checks, report facts and limits.
- **Stop before editing** when a new externally observable policy has no
  repository authority, intent is ambiguous, recovery is hard, or validation
  would weaken. Configurable defaults are not authority.
- TDD: write the failing test, prove RED, then implement. When RED is only
  "module not found", mutate the implementation deliberately to prove the
  assertions actually bite.
- Tests are colocated as `src/**/*.test.ts(x)`; `tests/**/*.test.ts` is also
  collected; `tests/e2e/**` belongs to Playwright only.
- `vitest.setup.ts` runs Testing Library `cleanup` after each test — Vitest runs
  without `globals`, so without it renders accumulate across tests.
- Lint enforces `react-hooks/set-state-in-effect` (never `setState`, directly or
  through a helper, in an effect body — use a promise continuation with a
  cancellation guard) and `@next/next/no-html-link-for-pages` (use `next/link`
  for static internal routes).
- Claim completion only with executable or observable evidence.
- Commits: `<type>: <description>` (`feat`, `fix`, `docs`, `chore`, `refactor`,
  `test`, `perf`, `ci`).

## Status

The original application plan is complete at
[`docs/plans/completed/2026-08-28-google-sheets-attendance-app.md`](docs/plans/completed/2026-08-28-google-sheets-attendance-app.md).
The Calendar-first redesign implementation is recorded in the active
[`docs/plans/active/2026-08-31-attendance-ui-redesign.md`](docs/plans/active/2026-08-31-attendance-ui-redesign.md);
its dedicated full responsive-state and manual accessibility audits remain
open. Current automated proof is 1,036 passing unit/integration tests, 51
passing Playwright tests, and 13 reference-workbook assertions that skip unless
the workbook path is supplied.

Read-only live browser QA has run with the installed Chrome profile
`linh.np@blended-asia.com`: the signed-in session, dashboard discovery, legacy
tab selection, and Sheets-backed day editor were observed on desktop and mobile
layouts with no console error. Final redesign QA deliberately did not perform a
write-side mutation against the live Google account; create/import/setup and
Save mutations are proven by the deterministic Playwright adapter. The operator
checklist remains in
[`docs/runbooks/google-cloud-setup.md`](docs/runbooks/google-cloud-setup.md).
