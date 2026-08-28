# Google Sheets Attendance Tool — Product and Technical Design

Date: 2026-08-28  
Status: Approved in conversation; pending written-spec review  
Reference workbook: `202607勤怠管理表.xlsx`

## 1. Outcome

Build an English-language Next.js web application that lets Google Workspace
users manage attendance files stored in Google Drive and Google Sheets.

The application must:

- authenticate users with Google OAuth;
- use the signed-in user's authority for Google Drive and Google Sheets API
  calls;
- let a file owner create a new monthly attendance spreadsheet with a
  user-entered name;
- let a file owner manually enter employee names and Google Workspace email
  addresses, create one tab per employee, share the file, and protect each tab;
- let a manager import an `.xlsx` workbook, map each existing sheet to an
  employee email, and convert it into a new Google Sheets file on Save;
- automatically discover relevant attendance files for managers and employees;
- map a signed-in employee to exactly one sheet tab and allow the employee to
  manage only that tab;
- provide both a 30-minute timeline editor and a start/end work-block editor;
- calculate work hours, handle the fixed lunch break, and save daily notes;
- run as a Dockerized Next.js application with application credentials supplied
  through environment variables.

Google Sheets remains the source of truth. The first version has no application
database.

## 2. Approved product decisions

### 2.1 Roles

- **Manager**: the current owner of a matching Google Sheets file. A manager can
  create/import files, add or remove member mappings, share files, configure
  protections, open employee tabs, and edit attendance data.
- **Employee**: a signed-in email mapped to one employee tab in the file's
  protected configuration. An employee can read and update only the mapped tab
  through the application.
- A user may be a manager for some files and an employee for other files.

“Creator” is interpreted as the file's current Google Drive owner because Drive
metadata does not expose an immutable original-creator field.

### 2.2 Member source

The application does not use the Google Workspace Admin SDK. Managers manually
enter each member's display name and Google email address.

The application creates or maps one sheet tab for each unique email address.
The employee never types a free-form name to select a tab after signing in.

### 2.3 Monthly files

Each attendance month is a separate Google Sheets file. The manager supplies the
file name and month. A generated file receives one employee tab per member plus
an application configuration tab.

### 2.4 Excel import

Import creates a new Google Sheets file. It does not merge into an existing
monthly file.

The import flow:

1. Accept an `.xlsx` file and inspect it locally/server-side.
2. Show all detected workbook sheet names before uploading to Drive.
3. Require the manager to assign a unique employee email to every employee
   sheet that will be managed by the application.
4. On Save, upload and convert the workbook to Google Sheets.
5. Add the application configuration, Drive metadata, member permissions, and
   per-sheet protections.
6. Keep the converted file if a later setup step fails and allow setup to
   resume.

The proposed first-version upload limit is 20 MB, configured by an environment
variable and documented in the UI.

## 3. Reference workbook contract

The supplied workbook contains four employee sheets with the same structure.
The application treats this structure as the initial template contract.

| Columns | Meaning | Web behavior |
| --- | --- | --- |
| A | Calendar date | Generated for every day in the selected month |
| B | Weekday | Derived from the date and displayed in English on the web |
| C | Business-day sequence (`営業日`) | Generated/maintained with the monthly template |
| D | Status (`ステータス`) | Enum-backed select control |
| E | Clock in (`出勤`) | 24-hour time, 30-minute increments |
| F | Clock out (`退勤`) | 24-hour time, 30-minute increments |
| G | Break (`休憩`) | Decimal hours, synchronized with lunch-break logic |
| H | Work hours (`労働時間`) | Formula: `clockOut - break - clockIn` |
| I | Notes (`備考`) | Free text for the selected day |
| J:AS | Work report (`作業時間報告`) | 30-minute work-description slots from 06:00 through 23:30 |

The workbook uses shared formulas for column H. Generated files must populate
the formula for applicable rows rather than hard-coding calculated values.

### 3.1 Status enum

The initial template contains these status values:

| Web label | Stored sheet value |
| --- | --- |
| Office | `出社` |
| Absent | `欠勤` |

The configuration stores enum codes, English labels, and raw sheet values. The
web uses a select control and never writes arbitrary status text. The enum may
be expanded by a future template version without changing the attendance-page
component contract.

### 3.2 Time and work-hour rules

- Clock in, clock out, break values, and work-block boundaries use 30-minute
  increments.
- `workHours = clockOut - breakHours - clockIn`.
- Clock out must be later than clock in.
- Break hours cannot be negative or greater than the clocked duration.
- A negative work-hour result is rejected before Save.
- The work-hours value shown on the web is derived from the same rule used in
  the sheet formula.

### 3.3 Lunch break

The day editor includes an English checkbox labeled
`Lunch break · 12:00–13:00`.

When selected:

- the 12:00 and 12:30 work slots are reserved and cannot receive work text;
- any work block crossing the lunch interval skips those two slots;
- existing work text in those slots is cleared only as part of the explicitly
  confirmed Save;
- break hours are set to `1`;
- work hours are recalculated.

When lunch is not selected, the two slots become editable and break hours may
be entered manually.

### 3.4 Notes

Notes are free text scoped to one day. They map directly to column I (`備考`)
and are saved with the other dirty fields for that day.

## 4. User experience

All default website text, actions, validation messages, empty states, and errors
are in English. Japanese strings remain only in the sheet integration contract
where needed for compatibility with the reference workbook.

Dates use readable English labels. Times use the 24-hour clock.

### 4.1 Dashboard

The dashboard has role-aware sections:

- **Managed attendance files** for matching files owned by the signed-in user.
- **My timesheets** for matching shared files whose protected configuration maps
  the signed-in email to one tab.

Cards show file name, month when available, owner, mapped tab/member count,
modified time, and setup state. Manager actions include Open, Manage members,
and Open in Google Sheets. Employee actions open the mapped timesheet directly.

### 4.2 Attendance editor

The attendance page combines two editing methods over one in-memory day model:

1. **Timeline editor**: one row per 30-minute slot. A user can edit an individual
   slot or select a contiguous set of slots.
2. **Work-block editor**: start and end controls accept `:00` and `:30`
   boundaries. Applying a block writes the same work description into all
   covered, non-lunch slots.

Editing with either method immediately updates the other view. An overlapping
block must show the cells that will be replaced before applying it.

The page also includes status, clock in, clock out, break, calculated work
hours, lunch-break control, daily notes, dirty-state indication, and an explicit
`Save to Google Sheets` action.

Save sends only changed cells. It must not rewrite an entire employee sheet or
entire day row when only a subset changed.

### 4.3 Create monthly file

The manager wizard has three stages:

1. File name and month.
2. Member rows containing display name and email.
3. Review and create.

Validation requires a non-empty file name/month, valid unique emails, unique
tab names, and valid Google Sheets tab-title characters. The create operation
generates dates, weekday formatting, status enum behavior, formulas, 30-minute
headers, employee tabs, the app configuration, Drive metadata, sharing, and
protections.

### 4.4 Manage members

A manager can add a name/email after file creation. The operation creates a new
employee tab from the current template, adds the email mapping, shares the file
if necessary, and applies protection.

Member mutations must be retryable. Removing a mapping or revoking Drive access
is a separate destructive flow and must require explicit confirmation; it is not
part of the first implementation unless separately approved.

## 5. Automatic file discovery

Automatic discovery intentionally scans Google Drive metadata so users do not
need to know spreadsheet IDs.

### 5.1 Common candidate rules

The server lists Google Sheets files from the user's Drive corpus with:

- MIME type `application/vnd.google-apps.spreadsheet`;
- `trashed = false`;
- pagination until the candidate result is complete;
- only the metadata fields required for filtering and display.

Drive's `name contains` query is prefix-based and cannot reliably match names
such as `202607勤怠管理表`. Therefore the server applies the final case-sensitive
substring test `name.includes("勤怠管理表")` after retrieving spreadsheet
candidates.

### 5.2 Employee filtering

An employee dashboard includes a file only when all conditions are true:

1. Drive reports the file in the user's `Shared with me` collection.
2. The current owner email ends with `@blended-asia.com` (case-insensitive
   comparison after normalization).
3. The file name contains `勤怠管理表`.
4. The protected `__APP_CONFIG` data maps the signed-in email to exactly one
   existing sheet ID/title.

A matching shared file without a valid mapping is not shown to an employee.

### 5.3 Manager filtering

A manager dashboard includes a file when:

1. the signed-in account is a current owner; and
2. the file name contains `勤怠管理表`.

Files with valid app configuration are ready to manage. Matching owner files
without app configuration appear as `Needs setup` and can enter the member
mapping flow. This supports legacy attendance spreadsheets without exposing
them to employees before safe mapping exists.

### 5.4 OAuth implication

Guaranteed discovery of all owned/shared file metadata requires
`https://www.googleapis.com/auth/drive.metadata.readonly`. The narrower
`drive.file` scope remains responsible for app-created or app-selected file
operations. Sheets access remains responsible for spreadsheet reads and writes.

`drive.metadata.readonly` is a restricted scope. Internal organizational use
may qualify for Google's internal-use verification exception, but the Workspace
organization may still require administrator approval. Development can proceed
with a testing OAuth audience and explicit test users.

## 6. Sheet-native metadata model

Every configured file contains a hidden sheet named `__APP_CONFIG`. The sheet is
protected so only the owner/manager can edit it.

The logical data includes:

- schema version;
- setup state (`pending`, `ready`, `needs-repair`);
- selected month;
- manager/owner email last verified during setup;
- template version;
- status enum mappings;
- employee display name;
- normalized employee email;
- employee sheet ID and title;
- protection IDs when available;
- invitation/setup status and last recoverable error.

Drive `appProperties` contain only compact discovery/setup markers such as
application schema version, month, and setup state. Detailed member data remains
in the protected configuration sheet.

Sheet IDs, not only titles, are stored so a renamed sheet can be recognized and
reconciled safely. User-facing errors identify a missing or conflicting sheet
rather than silently selecting another tab by name.

## 7. Access control and authorization

### 7.1 Google OAuth

Use a server-side OAuth authorization-code flow through the selected Next.js
authentication library. Request identity scopes plus:

- Google Sheets read/write access;
- `drive.file` for create/import/share operations on app-created or explicitly
  selected files;
- `drive.metadata.readonly` for automatic discovery.

Request offline access when needed to refresh short-lived access tokens.

### 7.2 Token handling

- `.env` stores application credentials only and is gitignored.
- `.env.example` documents required variable names without values.
- Google client secrets and refresh tokens are never exposed to browser
  JavaScript or `NEXT_PUBLIC_` variables.
- Per-user provider tokens live in encrypted, HttpOnly, Secure session state.
- Revoked/expired authorization redirects the user through re-consent without
  discarding unsaved form data where technically possible.

### 7.3 Defense in depth

Every server mutation:

1. obtains the normalized email from the verified server session;
2. retrieves current Drive ownership/access metadata;
3. retrieves the protected mapping for the file;
4. authorizes manager or employee access to the requested sheet;
5. restricts employee writes to the mapped employee sheet and approved ranges.

The Google Sheet itself is protected:

- the configuration sheet is owner-only;
- each employee sheet is protected with the owner and mapped employee as
  permitted editors;
- employees receive Drive writer permission so they can save through their own
  OAuth identity, while protected sheets prevent edits to other employee tabs.

Sheet protection prevents unauthorized edits but does not hide other tabs from
view. This visibility limitation was accepted as part of the design.

## 8. Google API operation flows

### 8.1 Create flow

1. Validate input.
2. Create the spreadsheet under the manager's OAuth identity.
3. Mark setup `pending` in Drive/app configuration.
4. Create template/config/employee sheets and formulas.
5. Add protections.
6. Create Drive permissions sequentially for unique employee emails.
7. Mark successful invitations as complete and retain individual failures.
8. Mark setup `ready` when all required structural steps succeed.

The file is never automatically deleted if a later setup step fails.

### 8.2 Import flow

1. Validate and parse the `.xlsx` upload without modifying Drive.
2. Show and validate sheet-to-email mappings.
3. Upload with the Google Sheets MIME type so Drive converts the workbook.
4. Mark setup `pending`.
5. Add/reconcile app configuration, metadata, mappings, protections, and
   invitations.
6. Keep the converted file and expose a retry/resume action for partial setup.

### 8.3 Attendance Save

1. Validate the day model and calculate the exact dirty A1 ranges.
2. Re-authorize file and sheet access.
3. Submit the smallest `values.batchUpdate`/spreadsheet batch operations needed.
4. On success, replace the local baseline with returned/current values.
5. On failure, preserve unsaved edits and present Retry or Re-authenticate.

Different-cell concurrent edits do not justify whole-row writes. Same-cell
concurrency remains last-writer-wins in the first version and is disclosed in
the UI if the source changed since it was loaded.

## 9. Validation and recovery

### 9.1 Input validation

- `.xlsx` only; reject encrypted/corrupt/unsupported workbooks.
- 20 MB import maximum.
- required file name and month;
- valid, normalized, unique emails;
- unique, legal sheet titles;
- one employee email per managed employee sheet;
- recognized monthly layout or an explicit unsupported-template error;
- 30-minute time boundaries;
- clock out after clock in;
- non-negative valid break and work hours;
- status value must exist in the configured enum;
- work block must be non-empty and contain at least one writable slot.

### 9.2 Partial failure

- Permission calls are serialized because concurrent permission changes on one
  file are unsupported by Google Drive.
- Setup records progress so retries do not duplicate tabs, protections, or
  permissions.
- A failed invitation is shown next to that member and can be retried alone.
- A failed attendance Save never clears the dirty form.
- A missing config/mapping/protection produces `Needs setup` or `Needs repair`,
  not silent fallback access.

## 10. Next.js and Docker structure

Use the Next.js App Router with TypeScript. Keep Google access server-side.

Proposed bounded components:

- authentication/session adapter;
- Google Drive gateway;
- Google Sheets gateway;
- workbook template/parser module;
- sheet-native config repository;
- access-policy service;
- file-discovery service;
- monthly-file setup service;
- Excel import/setup service;
- attendance domain model and range mapper;
- dashboard, manager wizards, and employee attendance UI.

The production Docker image uses Next.js standalone output and a non-root
runtime user. Docker Compose supports local production-like verification.

Expected environment variables include:

- Google OAuth client ID and client secret;
- authentication/session encryption secret;
- application base URL/callback URL;
- optional Google Picker public API key/app ID if retained as a manual fallback;
- import size limit;
- allowed owner domain (`blended-asia.com`);
- required attendance filename marker (`勤怠管理表`).

Only explicitly public browser configuration may use `NEXT_PUBLIC_`.

## 11. Verification strategy

### 11.1 Unit tests

- status English-to-sheet mapping;
- 30-minute header/column and column/header reverse mapping;
- work-block expansion and overlap handling;
- lunch-break skipping and break synchronization;
- work-hour calculation and invalid-time rejection;
- email normalization and email-to-sheet authorization;
- filename/domain/owner filtering;
- template date and formula generation.

### 11.2 Integration tests

- Drive list pagination and metadata filtering;
- create/import setup idempotency;
- sequential permission creation and failed-member retry;
- protected-sheet creation and reconciliation;
- employee attempts to access another mapped sheet;
- dirty-range attendance updates;
- token expiry/re-authentication behavior.

Google boundaries should be wrapped in small gateways so deterministic tests
can use fixtures without real credentials.

### 11.3 Browser tests

- Google sign-in boundary using a deterministic test adapter;
- manager creates a monthly file;
- manager imports and maps the reference workbook;
- manager discovers a legacy matching file and configures it;
- employee dashboard discovers only valid shared/mapped files;
- employee edits with timeline and work-block methods;
- lunch break, notes, status enum, calculation, Save, and retry states;
- unauthorized sheet navigation is rejected.

### 11.4 Runtime proof

- lint, typecheck, unit/integration tests, and production Next.js build;
- Docker image build;
- container health/readiness check;
- browser smoke test against the container;
- live Google OAuth/Drive/Sheets smoke test once valid test credentials and test
  accounts are supplied.

## 12. Known constraints and deployment risks

- Live Google integration cannot be proven without OAuth credentials, enabled
  APIs, callback URLs, and test Workspace accounts.
- The restricted Drive metadata scope may require organization administrator
  approval even for an internal app.
- Google sheet protections restrict editing but do not provide per-tab viewing
  confidentiality.
- A no-database architecture intentionally limits centralized audit history and
  cross-file analytics. These can be added later without changing the sheet
  attendance contract.
- Same-cell concurrent edits are last-writer-wins in the first version.

## 13. External references

- Next.js self-hosting and Docker:
  https://nextjs.org/docs/app/guides/self-hosting
- Next.js standalone output:
  https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Drive OAuth scopes:
  https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive file search:
  https://developers.google.com/workspace/drive/api/guides/search-files
- Drive search terms:
  https://developers.google.com/workspace/drive/api/guides/ref-search-terms
- Drive permission creation:
  https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create
- Drive custom properties:
  https://developers.google.com/workspace/drive/api/guides/properties
- Sheets batch updates:
  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- Sheets protected ranges:
  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets
- Restricted scope verification:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification

