# Drive Shared-With-Me Dashboard Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the invalid Google Drive v3 `sharedWithMe` response field while preserving shared-timesheet discovery through the supported query predicate.

**Architecture:** The Drive gateway owns the `sharedWithMe = true` selection boundary. Domain summaries contain only reusable file metadata, and discovery trusts the candidate method contract while retaining name, domain, config, and member-mapping filters.

**Tech Stack:** TypeScript 5.9, Next.js 16, Google Drive API v3, Vitest, Docker Compose, Chrome browser-client.

---

Date: 2026-08-29

## Status

Active

## Context

- Approved design: `docs/specs/2026-08-29-drive-shared-with-me-design.md`
- Live failure: Drive status `400`, `Invalid field selection sharedWithMe`, reason `invalidParameter`.
- Google boundary: `src/lib/google/types.ts` and `src/lib/google/drive-gateway.ts`.
- Consumer: `src/lib/discovery/file-discovery.ts`.

## Scope

In scope:

- Remove `sharedWithMe` from Drive response projections and domain/transport types.
- Preserve the `sharedWithMe = true` candidate query.
- Update all affected production fakes and test fixtures.
- Verify unit, integration, build, Docker, and signed-in Chrome behavior.

Out of scope:

- OAuth, Picker, scopes, Shared Drive support, and unrelated provider failures.
- Changes to the existing sanitized `APP_DEBUG_ERRORS` behavior.

## File Structure

- `src/lib/google/types.ts`: Drive projection and domain/transport contracts.
- `src/lib/google/drive-gateway.ts`: normalize valid Drive metadata and execute candidate query.
- `src/lib/discovery/file-discovery.ts`: consume the gateway's candidate contract.
- `src/lib/testing/fake-google-store.ts`: production-grade fake matching the gateway contract.
- `src/lib/google/drive-gateway.test.ts`: regression proof at the Google boundary.
- `src/lib/discovery/file-discovery.test.ts`: discovery filtering proof.
- `src/app/api/dashboard/route.test.ts`: dashboard route fixture contract.
- `src/lib/files/setup-service.test.ts`: setup service fixture contract.

## Task 1: Establish the failing Drive regression test

**Files:**

- Modify: `src/lib/google/drive-gateway.test.ts:1-165`

- [ ] **Step 1: Import the projection constant and make the fake response match Drive v3**

Add `FILE_SUMMARY_FIELDS` to the existing import from `./types`. Remove
`sharedWithMe: true` from both fake list response files in
`listEmployeeCandidates`.

```ts
import {
  FILE_SUMMARY_FIELDS,
  FOLDER_MIME_TYPE,
  SPREADSHEET_MIME_TYPE,
  XLSX_MIME_TYPE,
  type DriveFileResource,
} from "./types";
```

The attendance response fixture becomes:

```ts
{
  id: "file-1",
  name: "202607勤怠管理表",
  owners: [{ emailAddress: "Manager@Blended-Asia.com" }],
}
```

- [ ] **Step 2: Assert the response projection excludes the unsupported field**

Add this assertion next to the existing candidate query assertions:

```ts
expect(FILE_SUMMARY_FIELDS).not.toContain("sharedWithMe");
expect(fakeDrive.listCalls[0].fields).toBe(FILE_SUMMARY_FIELDS);
```

Update the expected summary by removing `sharedWithMe: true`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
docker compose run --rm test npm test -- src/lib/google/drive-gateway.test.ts
```

Expected: FAIL because `FILE_SUMMARY_FIELDS` still contains `sharedWithMe` and
the current normalized summary still contains `sharedWithMe: false`.

## Task 2: Remove the redundant field from production contracts

**Files:**

- Modify: `src/lib/google/types.ts:23-47,167-179`
- Modify: `src/lib/google/drive-gateway.ts:44-57`
- Modify: `src/lib/discovery/file-discovery.ts:254-257`
- Modify: `src/lib/testing/fake-google-store.ts:129-139`

- [ ] **Step 1: Make the Drive projection and types match v3**

Set the projection to:

```ts
export const FILE_SUMMARY_FIELDS =
  "nextPageToken,files(id,name,ownedByMe,owners(emailAddress),appProperties,modifiedTime)";
```

Remove the following member from `AttendanceFileSummary`:

```ts
sharedWithMe: boolean;
```

Remove the following member from `DriveFileResource`:

```ts
sharedWithMe?: boolean | null;
```

- [ ] **Step 2: Stop synthesizing the removed field**

Change `toFileSummary()` in the real gateway to return:

```ts
return {
  id: file.id,
  name: file.name,
  ownedByMe: file.ownedByMe === true,
  ownerEmail: ownerEmailOf(file),
  appProperties: file.appProperties ?? {},
  modifiedTime: file.modifiedTime ?? null,
};
```

Make the same removal from `toFileSummary()` in
`src/lib/testing/fake-google-store.ts`. Keep that fake's
`listEmployeeCandidates()` filter on `file.sharedWith.has(actorEmail)` because
the fake store models sharing internally, not the Google response shape.

- [ ] **Step 3: Trust the candidate gateway boundary in discovery**

Replace the candidate filter with:

```ts
const candidates = (await drive.listEmployeeCandidates()).filter(
  (file) => isInDomain(file.ownerEmail) && hasAttendanceName(file.name),
);
```

- [ ] **Step 4: Run the focused boundary test and verify GREEN**

Run:

```bash
docker compose run --rm test npm test -- src/lib/google/drive-gateway.test.ts
```

Expected: all tests in the file PASS.

## Task 3: Update affected fixtures and preserve discovery behavior

**Files:**

- Modify: `src/lib/discovery/file-discovery.test.ts:20-115,440-475`
- Modify: `src/app/api/dashboard/route.test.ts:40-55,185-200`
- Modify: `src/lib/files/setup-service.test.ts:375-400`

- [ ] **Step 1: Remove the field from summary fixtures**

Remove every `sharedWithMe` property from `AttendanceFileSummary` fixtures in
the three files. In `file-discovery.test.ts`, remove the `shared-not-shared`
entry because `sharedCorpus` represents the already-filtered output of
`listEmployeeCandidates()`, and remove this obsolete parameterized case:

```ts
["a file Drive does not report as shared with me", "shared-not-shared"],
```

- [ ] **Step 2: Run all directly affected tests**

Run:

```bash
docker compose run --rm test npm test -- src/lib/google/drive-gateway.test.ts src/lib/discovery/file-discovery.test.ts src/app/api/dashboard/route.test.ts src/lib/files/setup-service.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 3: Run TypeScript and repository searches**

Run:

```bash
docker compose run --rm test npm run typecheck
rg -n "sharedWithMe" src
```

Expected: typecheck exits `0`; the only production match is the supported query
string `sharedWithMe = true` in `src/lib/google/drive-gateway.ts`, while comments
or test assertions may mention the query term.

- [ ] **Step 4: Commit the coherent fix**

Stage only the files listed in Tasks 1-3 and commit:

```bash
git add src/lib/google/types.ts src/lib/google/drive-gateway.ts src/lib/discovery/file-discovery.ts src/lib/testing/fake-google-store.ts src/lib/google/drive-gateway.test.ts src/lib/discovery/file-discovery.test.ts src/app/api/dashboard/route.test.ts src/lib/files/setup-service.test.ts
git commit -m "fix: remove invalid Drive sharedWithMe field"
```

## Task 4: Verify, rebuild, and retest the live dashboard

**Files:**

- Modify during execution tracking: `docs/plans/active/2026-08-29-drive-shared-with-me-fix.md`

- [ ] **Step 1: Run the complete repository verification**

Run:

```bash
docker compose run --rm test npm run verify
git diff --check
```

Expected: lint, typecheck, all non-optional tests, and the Next.js production
build exit `0`; `git diff --check` exits `0`.

- [ ] **Step 2: Rebuild and recreate the app**

Run:

```bash
docker compose up --detach --build --force-recreate app
docker compose ps app
curl --fail --silent --show-error http://localhost:3000/api/health
```

Expected: service status is `healthy` and health returns `{"status":"ok"}`.

- [ ] **Step 3: Test the existing signed-in Chrome session**

Reload `http://localhost:3000/dashboard` in the existing Chrome profile and
inspect the accessibility snapshot, screenshot, dashboard API result, and
server logs.

Expected:

- The old `Invalid field selection sharedWithMe` diagnostic is absent.
- A successful response renders dashboard sections and no debug block.
- If Google reveals a different provider error, capture and diagnose it without
  expanding the fix beyond the approved scope.

- [ ] **Step 4: Record evidence and finish the plan**

Set the status to `Completed`, check each completed step, record exact test
counts, Docker health, and Chrome outcome under Result. Move the file to:

```text
docs/plans/completed/2026-08-29-drive-shared-with-me-fix.md
```

Commit only the completed plan record:

```bash
git add docs/plans/active/2026-08-29-drive-shared-with-me-fix.md docs/plans/completed/2026-08-29-drive-shared-with-me-fix.md
git commit -m "docs: complete Drive shared-with-me fix plan"
```

## Risks And Recovery

- Risk: discovery could accept non-shared fixtures after removing its redundant
  predicate. Mitigation: keep sharing selection inside every implementation of
  `listEmployeeCandidates()` and model the test boundary accurately.
- Risk: removing the field breaks unrelated fixture compilation. Mitigation:
  typecheck and search the entire `src` tree before full verification.
- Recovery: revert the focused implementation commit; the previously added
  sanitized debug output will again expose the original Google diagnostic.

## Decisions

- 2026-08-29: User selected removal of the redundant domain field instead of
  synthesizing it or adding per-file Google requests.
- 2026-08-29: The gateway method contract, not a returned boolean, owns the
  shared-with-me membership guarantee.

## Validation

- Focused proof: Drive gateway RED/GREEN plus all affected discovery, route, and
  setup-service tests.
- Integration or end-to-end proof: rebuilt Docker app and existing signed-in
  Chrome dashboard session.
- Repository-required checks: `npm run verify`, `git diff --check`, Docker
  health endpoint.

## Progress

- [ ] Task 1: Regression RED established.
- [ ] Task 2: Production contracts updated and focused GREEN established.
- [ ] Task 3: Fixtures updated, affected tests and typecheck pass.
- [ ] Task 4: Full verification, Docker rebuild, and Chrome test complete.

## Result

Pending implementation and validation.
