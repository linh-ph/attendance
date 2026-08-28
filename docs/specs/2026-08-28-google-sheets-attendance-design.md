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
  user-entered name in a manager-selected Google Drive folder;
- let a file owner manually enter employee names and Google Workspace email
  addresses, create one tab per employee, share the file, and protect each tab;
- let a manager import an `.xlsx` workbook, map each existing sheet to an
  employee email, and convert it into a new Google Sheets file on Save;
- automatically discover relevant attendance files for managers and employees;
- let a manager select one active My Drive folder and show only matching direct
  child files on the manager dashboard;
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
  create/import files, add member mappings, share files, configure protections,
  open employee tabs, and edit attendance data. Removing members or revoking
  access is outside the first-version scope.
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
2. Ask the manager for the output file name, attendance month, and destination
   My Drive folder. The upload's base file name is only an editable suggestion;
   the manager-confirmed value is authoritative and must contain `勤怠管理表`.
3. Show all detected workbook sheet names before uploading to Drive.
4. Require the manager to assign a unique employee email to every employee
   sheet that will be managed by the application.
5. Validate that every employee sheet's date rows belong to the
   manager-selected month.
6. On Save, upload and convert the workbook to Google Sheets in the selected
   folder using the manager-confirmed output name.
7. Add the application configuration, Drive metadata, member permissions, and
   per-sheet protections.
8. Keep the converted file if a later setup step fails and allow setup to
   resume.

The first-version upload limit is 20 MB and is documented in the UI.

### 2.5 Drive folder selection

Managers select folders through Google Picker. The first version supports one
active dashboard folder at a time and restricts selection to a writable folder
in the signed-in manager's My Drive. Shared Drives are outside scope because
their organization-owned files do not satisfy the current-owner manager model.
The Picker uses a folder-only view with folder display and selection enabled;
the server accepts the returned ID only after fetching `id`, `name`, `mimeType`,
`trashed`, `ownedByMe`, `driveId`, and `capabilities.canAddChildren` and
validating the rules below.

The manager dashboard includes matching files that are direct children of the
active folder only. It does not traverse descendant folders. The last selection
is remembered locally per normalized signed-in email; it is a convenience value,
not an authorization decision, and is not stored in an attendance workbook.

The active dashboard folder is the default destination for create and import.
The manager can choose a different destination in either wizard. As soon as
Drive successfully creates or converts the new file, that destination becomes
the active dashboard folder so the file is immediately visible. This also
applies when a later configuration or invitation step fails: the retained file
appears as `Needs setup` or `Needs repair` and exposes the existing resume flow.

## 3. Reference workbook contract

The supplied workbook contains four employee sheets with the same structure.
The application treats this structure as the initial template contract.

| Columns | Meaning | Web behavior |
| --- | --- | --- |
| A | Calendar date | Generated for every day in the selected month |
| B | Weekday | Derived from the date and displayed in English on the web |
| C | Business-day sequence (`営業日`) | Generated/maintained with the monthly template |
| D | Status (`ステータス`) | Enum-backed select control |
| E | Clock in (`出勤`) | Decimal hour in the sheet; rendered as 24-hour time on the web |
| F | Clock out (`退勤`) | Decimal hour in the sheet; rendered as 24-hour time on the web |
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

- The sheet stores clock values as decimal hours exactly like the reference
  workbook: `8` means 08:00 and `17.5` means 17:30. The web converts between
  these numbers and 24-hour display strings.
- Clock in, clock out, break values, and work-block boundaries use 30-minute
  increments.
- Both the web and sheet use `workHours = clockOutDecimal - breakHours -
  clockInDecimal`; generated column-H formulas use the equivalent `=F-G-E`.
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

The manager section has a required `Dashboard folder` control with `Select
folder` and `Change folder` actions backed by Google Picker. Before a valid
folder is selected, the section shows an empty state instead of scanning all
owned files. The selected folder name is displayed, while its ID remains an
internal value. If the folder is deleted, moved to a Shared Drive, trashed, or
no longer writable, the section shows `Folder unavailable` and requires a new
selection. The employee section and its discovery behavior are unaffected.

### 4.2 Attendance editor

The attendance page combines two editing methods over one in-memory day model:

1. **Timeline editor**: one row per 30-minute slot. A user can edit an individual
   slot or select a contiguous set of slots.
2. **Work-block editor**: start and end controls accept `:00` and `:30`
   boundaries. Blocks use a half-open interval `[start, end)`. For example,
   09:00–10:00 writes 09:00 and 09:30, but not 10:00. Applying a block writes
   the same work description into all covered, non-lunch slots.

Editing with either method immediately updates the other view. An overlapping
block must show the cells that will be replaced before applying it.

The page also includes status, clock in, clock out, break, calculated work
hours, lunch-break control, daily notes, dirty-state indication, and an explicit
`Save to Google Sheets` action.

Save sends only changed cells. It must not rewrite an entire employee sheet or
entire day row when only a subset changed.

### 4.3 Create monthly file

The manager wizard has three stages:

1. File name, month, and destination folder.
2. Member rows containing display name and email.
3. Review and create.

Validation requires a non-empty file name/month, a file name containing the
accepted marker `勤怠管理表`, a valid writable destination folder in the
manager's My Drive, valid unique emails, unique tab names, and valid Google
Sheets tab-title characters. The create operation places the new file directly
in that folder and generates dates, weekday formatting, status enum behavior,
formulas, 30-minute headers, employee tabs, the app configuration, Drive
metadata, sharing, and protections.

### 4.4 Manage members

A manager can add a name/email after file creation. The operation creates a new
employee tab from the current template, adds the email mapping, shares the file
if necessary, and applies protection.

Adding a member must be retryable. Removing a mapping or revoking Drive access
is a separate destructive flow and is not part of the first implementation.

## 5. Automatic file discovery

Employee discovery scans Google Drive metadata so employees do not need to know
spreadsheet IDs. Manager discovery is intentionally scoped to the manager's
selected direct-parent folder.

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

A manager dashboard first validates the supplied active folder ID by retrieving
its metadata. The folder must be untrashed, have the Google Drive folder MIME
type, belong to the signed-in user's My Drive rather than a Shared Drive, be
owned by that user, and report the capability to add children. A folder ID from
browser storage is never trusted without this server-side check.

The server then lists direct children using a Drive query equivalent to:

`'<folderId>' in parents and mimeType =
'application/vnd.google-apps.spreadsheet' and trashed = false`

A manager dashboard includes a returned file when:

1. the signed-in account is a current owner; and
2. the file name contains `勤怠管理表` using the same final case-sensitive
   substring check as section 5.1.

The server paginates until the selected folder's direct-child candidate set is
complete. Files outside the selected folder and files only inside descendant
folders are not shown. Selecting another folder replaces the active manager
view; it does not move any existing file.

Files with valid app configuration are ready to manage. Matching owner files
without app configuration appear as `Needs setup`. To start setup, the manager
must explicitly select that same file through Google Picker. The Picker action
grants the app per-file access under `drive.file`; metadata discovery alone does
not authorize Drive permission mutations on a legacy file. After selection, the
file enters the member mapping flow. This supports legacy attendance
spreadsheets without exposing them to employees before safe mapping exists or
requesting full Drive read/write access.

### 5.4 OAuth implication

Guaranteed discovery of all owned/shared file metadata requires
`https://www.googleapis.com/auth/drive.metadata.readonly`. The narrower
`drive.file` scope remains responsible for app-created or app-selected file
operations, including folders selected through Google Picker. Sheets access
remains responsible for spreadsheet reads and writes.

`drive.metadata.readonly` is a restricted scope. Internal organizational use
may qualify for Google's internal-use verification exception, but the Workspace
organization may still require administrator approval. Development can proceed
with a testing OAuth audience and explicit test users.

## 6. Sheet-native metadata model

Every configured file contains a hidden sheet named `__APP_CONFIG`. The sheet is
protected so only the owner/manager can edit it.

The first schema version has fixed tables and coordinates:

| Range | Purpose | Columns/keys |
| --- | --- | --- |
| `A1:B5` | Settings key/value table | `schemaVersion`, `setupState`, `month`, `ownerEmail`, `templateVersion` |
| `D1:F` | Status enum table | Header in row 1; data rows contain `code`, `labelEn`, `sheetValue` until the first fully blank row |
| `H1:N` | Member table | Header in row 1; data rows contain `displayName`, `email`, `sheetId`, `sheetTitle`, `protectionId`, `permissionId`, `setupStatus` until the first fully blank row |

Emails are normalized to lowercase before storage and comparison. Numeric Google
resource IDs are stored as strings. Empty member rows have no meaning; member
identity is the normalized email. A future schema change increments
`schemaVersion` and requires an explicit reader/migration rather than silently
reinterpreting columns.

Drive `appProperties` use fixed keys with string values:

- `attendanceApp = "v1"`;
- `attendanceSetupState = "pending" | "ready" | "needs-repair"`;
- `attendanceMonth = "YYYY-MM"`.

Detailed member data remains in the protected configuration sheet.

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
- Browser storage may contain only the last selected dashboard folder ID and
  display name under a key scoped by normalized signed-in email. It never stores
  OAuth tokens, application secrets, or an authorization result.

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

1. Validate input and revalidate the selected destination folder's metadata and
   capabilities under the manager's OAuth identity.
2. Create the Google Sheets file through Drive `files.create` with the Sheets
   MIME type and `parents: [folderId]`, so it is placed directly in the selected
   folder under the manager's ownership.
3. Mark setup `pending` in Drive/app configuration.
4. Create template/config/employee sheets and formulas.
5. Add protections.
6. Create Drive permissions sequentially for unique employee emails.
7. Mark successful invitations as complete and retain individual failures.
8. Mark setup `ready` when all required structural steps succeed.
9. Return the destination folder ID/name as soon as Drive file creation succeeds
   so the browser makes it active even if a later setup step returns a partial
   failure.

The file is never automatically deleted if a later setup step fails.

### 8.2 Import flow

1. Validate and parse the `.xlsx` upload without modifying Drive.
2. Ask the manager to confirm an output file name, attendance month, and
   destination folder; prefill the file name from the upload base name but do
   not derive the month from the name.
3. Classify every non-configuration sheet using the recognized employee-layout
   contract below, validate that its date rows match the selected month, then
   show and validate sheet-to-email mappings.
4. Revalidate the destination folder, then upload with the Google Sheets MIME
   type, confirmed output name, and `parents: [folderId]` so Drive converts the
   workbook directly in that folder.
5. Mark setup `pending` and store the selected month.
6. Add/reconcile app configuration, metadata, mappings, protections, and
   invitations.
7. Keep the converted file and expose a retry/resume action for partial setup.
8. Once Drive conversion succeeds, return the destination folder ID/name so it
   becomes active even if a later setup step returns a partial failure.

The first version supports employee-attendance workbooks only. Every visible
sheet other than an existing reserved `__APP_CONFIG` sheet must match all of
these checks:

- row 3 contains `ステータス`, `出勤`, `退勤`, `休憩`, `労働時間`, and `備考`
  in columns D through I;
- row 2 uses merged two-column hour headers across J:AS: `J2:K2 = 6`,
  `L2:M2 = 7`, continuing by one hour until `AR2:AS2 = 23`;
- row 3 contains alternating minute values across J:AS: J3 is `0`, K3 is `30`,
  continuing `0`, `30` through AR3 and AS3;
- the daily data region starts at row 4 and column-A date rows belong to the
  manager-selected month;
- column H contains or can be reconciled to the `=F-G-E` formula pattern.

If any non-configuration sheet fails, import is blocked before upload and the UI
lists each failing sheet and check. Auxiliary/non-attendance sheets are not
supported in the first version. An existing `__APP_CONFIG` sheet is not trusted
from the upload; setup replaces it with the current schema after the manager
confirms the import mapping.

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
- required output file name and month, with the output name containing
  `勤怠管理表`;
- required destination folder selected through Google Picker and revalidated as
  a writable, owned My Drive folder immediately before create/import;
- valid, normalized, unique emails;
- unique, legal sheet titles;
- one employee email per managed employee sheet;
- every non-configuration sheet satisfies the explicit employee-layout checks
  in section 8.2, otherwise show an unsupported-template error before upload;
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
- A missing, trashed, Shared Drive, unowned, or non-writable dashboard folder
  produces `Folder unavailable`; no fallback to an all-Drive scan is allowed.
- A create/import request whose destination folder becomes invalid before Save
  is rejected before file creation and preserves the wizard input for retry.
- If Drive creates/converts the file but a later setup step fails, the response
  retains the file ID and destination folder; the browser activates that folder
  and shows the partial file with its resume action.

## 10. Next.js and Docker structure

Use the Next.js App Router with TypeScript. Keep Google access server-side.

Proposed bounded components:

- authentication/session adapter;
- Google Drive gateway;
- Google Picker folder adapter and dashboard-folder preference adapter;
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
- Google Picker public API key/app ID for explicit legacy-file authorization;
- application base/runtime settings required by the deployment platform.

The 20 MB import limit, allowed owner domain `blended-asia.com`, and required
filename marker `勤怠管理表` are accepted product rules, not runtime-configurable
defaults. Changing them requires a product-contract change.

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
- dashboard-folder validation and direct-parent filtering;
- template date and formula generation.

### 11.2 Integration tests

- Drive list pagination and metadata filtering;
- Picker-selected My Drive folder validation, including rejection of Shared
  Drive, trashed, unowned, and non-writable folders;
- direct-child manager listing that excludes descendants and files outside the
  active folder;
- create/import requests pass exactly one selected parent folder and reject a
  destination that becomes invalid before creation;
- create/import setup idempotency;
- Google Picker authorization for a legacy file and refusal to mutate the file
  before the manager explicitly selects it;
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
- manager selects and changes a dashboard folder, sees only direct matching
  children, and sees a newly created/imported file immediately;
- manager receives the `Folder unavailable` state when a remembered folder can
  no longer be used;
- manager discovers a legacy matching file and configures it;
- legacy setup remains read-only until the manager selects the file in Google
  Picker;
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
- The selected manager dashboard folder is browser-local and does not synchronize
  across devices or browsers; the manager selects it again on a new browser.
- Shared Drive folders are not supported in the first version.
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
- Drive folder creation and direct parent placement:
  https://developers.google.com/workspace/drive/api/guides/folder
- Drive search terms:
  https://developers.google.com/workspace/drive/api/guides/ref-search-terms
- Google Picker folder selection:
  https://developers.google.com/workspace/drive/picker/reference/picker.docsview
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
