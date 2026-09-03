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

English-language Next.js app where **Google Sheets is the only datastore for
attendance**. Each signed-in user's own Google OAuth authority performs every
Drive/Sheets call — no service account, and no attendance data outside the
sheets.

Since [`docs/decisions/2026-09-02-supabase-holds-google-credentials.md`](docs/decisions/2026-09-02-supabase-holds-google-credentials.md)
there **is** a database, holding two things and nothing else: who has signed in
(`profiles`, mirrored from `auth.users`) and each person's Google refresh token
(`google_credentials`, encrypted). See **Identity** below.

**Stack:** Node 24.19 on Debian slim, Next.js 16.3.3 App Router, React 19.2.8,
TypeScript, Auth.js/NextAuth `5.0.0-beta.32`, Supabase (`@supabase/ssr`,
`@supabase/supabase-js`), `googleapis` 176, Google Picker,
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

### Deployment

Push to `main` → CI → CD syncs the environment into Vercel and deploys the
commit CI verified. See [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md).

```bash
./scripts/push-github-secrets.sh --dry-run   # local .env -> GitHub secrets
node --env-file=.env --env-file=.env.production scripts/sync-vercel-env.mjs --dry-run
```

The three deployment scripts are zero-dependency — standard library only, no
`node_modules` — so CI and CD run them on `actions/setup-node` pinned to the
same 24.19.0 rather than pulling a Docker image to execute one file. That is
not a hole in the Docker-first rule: the rule exists because the toolchain and
`node_modules` are pinned, and neither is involved here.

## Layout

```
src/lib/
  attendance/   model, time, slots, validation, range-mapper   ← pure domain
                service.ts                                     ← read + exact-range save
  workbook/     contract, template, xlsx-inspector             ← pure
  google/       types, errors, client, drive-gateway,
                sheets-gateway, picker                         ← only googleapis site
  config/       schema, repository                             ← __APP_CONFIG writes only
  access/       policy                                         ← per-request authorization
  files/        schemas, import-schemas, setup-{service,contracts,steps,
                monthly,legacy}, member-service, import-service ← orchestration
  discovery/    file-discovery                                 ← folder-scoped listing
  dashboard/    folder preference and compatibility cache adapter
  cache/        acknowledged IndexedDB cache, epochs, revisions, migrations,
                calendar-pointer (last file/tab/month, not a second store)
  sync/         calendar-sync, sync-transport, shared-fetch  ← one load path
  directory/    browser-local member roster and Drive suggestions
  auth/         session (Edge-safe), google-session (server-only composition),
                google-token, proxy, paths, provider
  supabase/     server, client, middleware, request-user, session,
                token-crypto, google-credentials, credential-table
  testing/      runtime-guard, fake-google-{store,state,seed,requests}
src/components/ app-shell, month-calendar, day-quick-preview, wizard-shell,
                sync-status, attendance editors and shared primitives
src/app/api/    health, auth, dashboard, folders/validate, google/picker-token,
                files/create, files/import[/inspect],
                files/[fileId]/{setup,members,attendance/[sheetId]}, e2e/reset
src/app/auth/callback/  where Supabase returns after Google consent (public)
supabase/migrations/    SQL applied by hand — see docs/runbooks/supabase-auth-setup.md
src/app/(authenticated)/  dashboard, timesheets, manage, members, more,
                          files/new, files/import,
                          files/[fileId]/{setup,members,attendance/[sheetId]}
tests/          e2e/ (Playwright), fakes/, fixtures/, reference-workbook.test.ts
scripts/        deploy-env.manifest        ← the one list of deployed variables
                verify-supabase.mjs        ← CI's live-project check
                push-github-secrets.sh     ← .env -> GitHub secrets
                sync-vercel-env.mjs        ← GitHub secrets -> Vercel (in CD)
                deploy-vercel.mjs          ← deploys one sha, waits, reports
.github/workflows/  ci.yml, cd.yml — see docs/runbooks/deployment.md
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

**`__APP_CONFIG` is read for exactly one thing: `H1:N`, by discovery.**

Everything else the read path once took from that sheet still comes from
cheaper, always-present sources. `access/policy` and `attendance/service` open
no configuration sheet at all.

| Was read from the sheet | Comes from now |
| --- | --- |
| the month | `appProperties.attendanceMonth`, else the `202607勤怠管理表` name |
| the status enum | `STATUS_OPTIONS` — the sheet only mirrored it back |
| the member → tab mapping | **`__APP_CONFIG!H1:N`, restored 2026-09-03** — see [`docs/decisions/2026-09-03-discovery-maps-the-actor-to-their-tab.md`](docs/decisions/2026-09-03-discovery-maps-the-actor-to-their-tab.md) |
| the managed card's setup state | `appProperties.attendanceSetupState`; no stamp means `needs-setup` |

Consequences to keep:

- `FileRole` is `manager` (the current Drive owner) or `open` (everyone else).
  There is no `employee` role and no per-member tab restriction.
- **The hidden configuration tab is still refused as a place to record hours**,
  for reads and for writes. Dropping the mapping must not turn that sheet into
  an editable grid — a save would write attendance columns over the settings
  table. `attendance/service` refuses any hidden tab.
- Discovery preselects a tab **only** from a `H1:N` row whose **email** equals
  the verified session email. It still never matches a tab title against a
  name: that is the silent fallback the workbook contract forbids, and it would
  open a colleague's tab the day two names collide. Everything else —
  no config tab, no row, an unreadable or malformed table, a row pointing at a
  deleted or hidden tab — yields `sheetId: null` and the person picks from
  `tabs`. The mapping is a convenience and must never decide whether a file is
  listed or make the calendar fail.
- The mapping costs nothing where there is nothing to read: the tab list from
  `getSpreadsheet` already says whether `__APP_CONFIG` exists, so a file
  without one issues no extra call, and only `H1:N` is ever fetched — never the
  whole configuration. That was the measured objection that removed this in the
  first place.
- A server mapping outranks the browser's remembered tab choice, and the
  in-calendar tab picker only renders when `sheetId` is `null`. So a mapped
  person cannot switch tabs from the calendar — which is intended, and is what
  the pre-2026-09-01 behavior did.
- `memberCount` on a managed card is always `null`; counting it would mean
  opening every file, and discovery reads only the member range of files it is
  already opening.

The manager-side writers (`files/setup-*`, `files/member-service`,
`files/import-service`) still create and update the sheet, so its shape still
matters where they touch it:

- `A1:B5` settings, `D1:F` status enum, `H1:N` members — each table ends at the
  first fully blank row. Emails lowercase-normalized; Google numeric IDs stored
  as strings; member identity is the email; sheet **IDs** are stored.
- Member `setupStatus` is exactly `pending` | `ready` | `invite-failed`.
- `protectionId` is always `null`: **employee tabs are created open.** Only the
  hidden `__APP_CONFIG` sheet keeps its owner-only protection.
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
   cached role, and reads **Drive metadata only**;
3. the current Drive owner is `manager`; everyone else is `open` and the
   requested tab is taken as given;
4. `ownedByMe` is **not** required anywhere. Shared Drive files are owned by the
   organization and have no owner at all, and they are exactly the files people
   record hours in;
5. the only tabs refused are ones the file does not have, and hidden ones —
   which is what keeps `__APP_CONFIG` out of the attendance editor.

`authorizeFile` gates on no configuration at all: not on `setupState`, not on a
member row, not on the sheet's presence.

Cross-tab editing is out of scope: it is a Google Sheets sharing concern. If
per-tab isolation is ever wanted it comes from protected ranges on the file, not
from this app.

**Sheet creation vs. reconciliation**
- `buildEmployeeSheetPlan` emits an `updateSheetProperties` request that shrinks
  `rowCount` to the month's rows. Safe on a **freshly added** tab, destructive if
  replayed onto a populated one. Legacy setup and import adopt existing tabs and
  must never replay it.

**Identity — two sign-in paths, one authorization**
- Auth.js and Supabase Auth are both live. `src/lib/auth/google-session.ts` is
  the only thing route handlers ask: Supabase first, Auth.js as fallback. Never
  import `requireGoogleSessionFromRequest` from `@/lib/auth/session` in a route
  — that is the Edge-safe half, and it does not see Supabase sessions.
- `src/lib/auth/session.ts` and `src/lib/supabase/middleware.ts` must stay
  **Edge-safe**. `google-session.ts`, `google-credentials.ts`, `token-crypto.ts`
  and `credential-table.ts` reach `node:crypto` or the service role and are
  **server-only**; importing one from the proxy breaks the Edge bundle.
- `AUTH_PROVIDER` chooses which button `/login` shows. It is an explicit opt-in,
  not inferred from configuration: Supabase can be configured here while its
  Google provider is not yet configured in the Supabase dashboard, and guessing
  wrong there makes sign-in impossible with no way back.
- The identity always comes from `getUser()`, never `getSession()` — the latter
  returns what the cookie claims, and the proxy admits requests on that answer.
- A Supabase user with no email is refused. Every authorization decision
  downstream is keyed on the normalized email.
- A missing or refused Google credential is `UnauthenticatedError`; a storage
  outage is **not** — reporting one as "sign in again" loops a person through
  consent forever without fixing anything.
- `/auth/callback` is public, and is the **only** moment Google hands over a
  refresh token. `prompt=consent` is required, not cosmetic: without it a
  returning account completes sign-in and the callback has nothing to store.
- Refresh tokens are AES-256-GCM encrypted (`v1.<iv>.<tag>.<ciphertext>`) with
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, which the database does not hold. Rotating that
  key invalidates every stored connection — there is no re-encryption path.
- `google_credentials` has RLS enabled with **no policy** and grants revoked
  from `anon`/`authenticated`. Adding a policy to it would expose refresh
  tokens to browser keys. Only the service role reaches it.
- Nothing returns a refresh token to a caller. `accessTokenFor` returns a
  short-lived access token and nothing else.

**Secrets**
- Client secrets and refresh tokens never reach browser JS or a `NEXT_PUBLIC_`
  variable. Only `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`,
  `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER`, `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are public. The publishable key grants
  nothing on its own — RLS decides what it reaches.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely and
  `GOOGLE_TOKEN_ENCRYPTION_KEY` decrypts every stored Google connection. Neither
  may ever be prefixed `NEXT_PUBLIC_` or imported by browser-bundled code.
- The Picker token is short-lived, returned with `Cache-Control: private,
  no-store`, held in component memory only.
- Browser storage never holds a token or an authorization result. It holds the
  selected folder ID/name in `localStorage`, and — in the `attendance-local`
  IndexedDB database — unsaved day drafts, the last loaded month per sheet,
  recently opened sheets, and one calendar pointer per account naming the file,
  tab, and month last shown. The pointer is an **address, not a copy**: the
  month it names lives in the acknowledged month cache and is never duplicated
  alongside it. Every record is
  keyed by normalized email so two accounts sharing a browser profile cannot
  read each other's, and none of it is authoritative: the server re-reads the
  sheet and re-authorizes every request. `findCredentialMaterial` refuses any
  write carrying a token **or an authorization result** — `role` is on that
  deny list, so no cached role can ever be read back. These records deliberately **survive sign-out** (an explicit product
  decision on 2026-08-29), so a shared machine keeps one user's work-hour
  drafts until that profile is cleared.
- A stored draft carries the baseline it was made against and is restored only
  onto an identical baseline. If the sheet moved on, the draft is dropped
  rather than replayed over newer data.
- A pasted Google Sheets link is a shortcut, never an access path: it resolves
  only against files the dashboard already listed, its `gid` is discarded so it
  cannot address an unmapped tab, and the destination route re-authorizes.
- `.env`, `.env.e2e` and `.env.production` are gitignored; the `.example` files
  document names only.

**Deployment**
- `scripts/deploy-env.manifest` has **one** definition of which variables move
  and how far. `push-github-secrets.sh`, `sync-vercel-env.mjs` and `cd.yml` all
  read it. If those lists diverged the failure is silent: a variable the app
  needs is simply absent in production, and Next.js does not complain at build
  time — it fails on the first request that reaches the missing value.
- The `SCOPE` column is a security boundary. `runtime` reaches the deployed app;
  `deploy` (the Vercel token, which can redeploy the project and read every
  variable in it) stops at GitHub. `DATABASE_PASSWORD`, `SUPABASE_DB_HOST` and
  `SUPABASE_PROJECT_REF` are in neither — the app never opens a Postgres
  connection, so shipping them is pure blast radius. `E2E_TEST_MODE` is never
  sent anywhere.
- CD syncs the environment **before** it deploys. Vercel resolves environment
  variables when a deployment is *built*, so syncing afterwards yields a green
  pipeline and a deployment running the previous environment.
- CD deploys **by sha**, the commit CI verified — not a branch. The project's
  own Git integration also deploys on push, in parallel with CI, from code
  nothing has checked yet; the CD deployment is the authoritative last write.
- An `optional` runtime variable that is unset upstream is **removed** from the
  Vercel project, not left alone. Otherwise a value deliberately cleared keeps
  running in production forever — which is exactly `APP_DEBUG_ERRORS`, whose
  stale `1` would keep server-side error disclosure on. Variables outside the
  manifest are never touched.
- `push-github-secrets.sh` refuses a localhost or non-https `AUTH_URL` and an
  `APP_DEBUG_ERRORS=1`. Both are correct locally and break production quietly:
  the first sends OAuth redirects to a machine Google cannot reach, the second
  leaks internals. Production-only values belong in `.env.production`, where an
  empty value means "unset" rather than "fall back to `.env`".

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
