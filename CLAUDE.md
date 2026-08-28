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

```bash
cp .env.example .env                              # first run only; .env is gitignored
docker compose build test
docker compose run --rm test npm run verify       # lint + typecheck + test + build
docker compose run --rm test npm run test:e2e     # Playwright, 26 specs
docker compose up --build app                     # http://localhost:3000
```

Readiness: `GET /api/health` (unauthenticated).

Optional proof against the real supplied workbook:

```bash
docker compose run --rm \
  --env REFERENCE_XLSX_PATH=/app/202607勤怠管理表.xlsx \
  test npm test -- tests/reference-workbook.test.ts
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
  dashboard/    folder-preference                              ← browser-only, non-authoritative
  auth/         session, google-token, proxy, paths
  testing/      runtime-guard, fake-google-{store,state,seed,requests}
src/app/api/    health, auth, dashboard, folders/validate, google/picker-token,
                files/create, files/import[/inspect],
                files/[fileId]/{setup,members,attendance/[sheetId]}, e2e/reset
src/app/(authenticated)/  dashboard, files/new, files/import,
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

**Writes**
- `ValuePatch.inputOption` defaults to `USER_ENTERED` so the `=F-G-E` contract
  works. Free text — column I notes and the J:AS slots — must be sent as `RAW`,
  or a note beginning with `=` becomes a formula and `2026-07` becomes a date.
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
  so partial setup is recordable. A null mapping is `NeedsSetupError`, a stale
  one `NeedsRepairError` — never a silent title-match fallback.
- `initialize` refuses to overwrite an existing config sheet unless the caller
  passes `replaceExisting: true` (the import path's switch). `deleteSheet` is
  emitted on no other path.
- A schema change increments `schemaVersion` and needs an explicit reader.

**Authorization — every server mutation, no exceptions**
1. normalized email from the verified server session (never a client-supplied one);
2. current Drive ownership/access metadata;
3. the protected mapping for the file;
4. manager-or-employee authorization for the requested sheet;
5. employee writes restricted to their mapped sheet and approved ranges.

`authorizeFile` deliberately does **not** gate on the file-level `setupState`:
spec 7.3 scopes the employee check to a valid mapping, the policy already
rejects a stale mapping per member, and gating globally would lock a manager out
of repairing their own file.

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
- Browser storage holds only the selected folder ID/name keyed by normalized
  email — never tokens or an authorization result.
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

All 13 planned tasks are complete; the plan is at
[`docs/plans/completed/2026-08-28-google-sheets-attendance-app.md`](docs/plans/completed/2026-08-28-google-sheets-attendance-app.md)
with per-task proof. 563 unit/integration tests, 26 Playwright specs, and 13
reference-workbook assertions (skipped unless the workbook path is supplied).

**Live Google proof has never run.** No OAuth client, Workspace test accounts,
or organization approval for `drive.metadata.readonly` exists in this
environment, so no real Drive, Sheets, or Picker call has ever been made. The
application is proven against its specification with deterministic fakes and
against the real supplied workbook for the file contract — **not** against
Google. [`docs/runbooks/google-cloud-setup.md`](docs/runbooks/google-cloud-setup.md)
carries the operator prerequisites and the smoke checklist that must be run
once credentials exist.
