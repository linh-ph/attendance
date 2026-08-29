# Drive Shared-With-Me Dashboard Fix

## Outcome

The authenticated dashboard loads Google Drive candidates without requesting
the unsupported `sharedWithMe` file resource field. Employee timesheets remain
restricted to files returned by the Drive query `sharedWithMe = true`.

## Evidence and Authority

- The live dashboard request fails consistently with Google Drive status `400`,
  provider message `Invalid field selection sharedWithMe`, and reason
  `invalidParameter` during `files.list shared candidates`.
- Google Drive API v3 documents `sharedWithMe` as a valid file search query term,
  while the v3 File resource exposes `sharedWithMeTime` and does not expose a
  `sharedWithMe` boolean response field:
  - https://developers.google.com/workspace/drive/api/guides/ref-search-terms
  - https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- The user selected and approved removing the redundant `sharedWithMe` flag from
  the domain model instead of synthesizing it or making extra API calls.

## Design

### Google boundary

- Remove `sharedWithMe` from `FILE_SUMMARY_FIELDS` so `files.list` requests only
  valid Drive v3 File resource fields.
- Keep `sharedWithMe = true` in `listEmployeeCandidates()` as the single boundary
  guarantee that every returned candidate belongs to the signed-in user's
  Shared with me collection.
- Remove `sharedWithMe` from `DriveFileResource` and `AttendanceFileSummary`.
  The response type represents metadata actually returned by Drive rather than
  duplicating the query predicate as a synthetic field.

### Discovery

- `createFileDiscovery().loadTimesheets()` continues to consume only
  `drive.listEmployeeCandidates()` results.
- Remove its redundant `file.sharedWithMe` predicate. Preserve the existing
  attendance-name and owner-domain checks and all configuration/member mapping
  checks.
- Manager folder discovery is unchanged except that summaries no longer carry
  an unused `sharedWithMe: false` property.

### Tests

- Add a regression assertion that `FILE_SUMMARY_FIELDS` does not request
  `sharedWithMe`.
- Make the Drive gateway test mimic the real v3 response by omitting that field,
  while proving the shared-with-me query and candidate result remain correct.
- Update discovery, API route, and test fixtures to the smaller domain contract.
- First run the focused regression test in the current code and confirm it fails
  because the invalid field is still present. Implement only after that RED
  proof, then rerun focused and full repository verification.
- Rebuild and recreate the Docker app, verify health, then reload the existing
  signed-in Chrome session. Confirm the dashboard no longer reports the
  `Invalid field selection sharedWithMe` error and inspect any next provider or
  UI error before claiming the dashboard is healthy.

## Error Handling and Security

- The existing `APP_DEBUG_ERRORS=1` behavior remains enabled for local diagnosis.
- Sanitized diagnostics continue to redact OAuth access tokens, bearer tokens,
  client secrets, and Auth.js secrets.
- No additional Drive scopes, permissions, API calls, or browser storage are
  introduced.

## Non-goals

- Changing Google OAuth or Picker configuration.
- Adding Shared Drive support.
- Refactoring unrelated dashboard discovery, configuration parsing, or UI.
- Automatically fixing any different Google/provider error revealed after this
  specific invalid-field failure is removed.

## Acceptance Criteria

1. No Drive `fields` projection contains `sharedWithMe`.
2. The employee-candidate query still contains `sharedWithMe = true`.
3. `AttendanceFileSummary` and `DriveFileResource` do not expose a
   `sharedWithMe` boolean.
4. Shared attendance candidates still produce employee timesheets; unrelated,
   external-domain, unmapped, and unreadable files remain excluded.
5. Focused tests, lint, typecheck, full tests, and production build pass.
6. The rebuilt Docker app is healthy and live Chrome testing no longer produces
   `Invalid field selection sharedWithMe`.
