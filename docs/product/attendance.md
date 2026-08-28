# Attendance

Current product behavior for the Google Sheets attendance application. This
document distils the approved design; it does not replace it. The authoritative
source is
[`docs/specs/2026-08-28-google-sheets-attendance-design.md`](../specs/2026-08-28-google-sheets-attendance-design.md).

Google Sheets is the source of truth. The application has no database.

## Roles

- **Manager** — the current Google Drive owner of a matching file. A manager can
  create and import files, add member mappings, share files, configure sheet
  protections, open any employee tab in that file, and edit attendance data.
- **Employee** — a signed-in email that the file's protected configuration maps
  to exactly one employee tab. An employee can read and update only that tab
  through the application.

One user can be a manager for some files and an employee for others. "Creator"
means the file's current Drive owner, because Drive exposes no immutable
original-creator field. Removing members and revoking access are outside the
first version.

Members are entered by hand. The application does not use the Workspace Admin
SDK. Each unique email address gets one sheet tab, and employees never type a
free-form name to pick a tab.

## Files and folders

Each attendance month is a separate Google Sheets file. A manager supplies the
file name and month; the name must contain `勤怠管理表`. A generated file has one
tab per member plus a hidden, protected `__APP_CONFIG` tab.

Managers pick a destination folder through Google Picker. Exactly one dashboard
folder is active at a time, and it must be an untrashed, owned, writable folder
in the manager's My Drive. Shared Drives are out of scope. The server revalidates
the folder's Drive metadata — owner, MIME type, trashed state, `driveId`, and
`capabilities.canAddChildren` — before it trusts an ID from the browser.

The active folder is the default destination for create and import, and the
manager may choose another one in either wizard. As soon as Drive creates or
converts a file, its destination becomes the active dashboard folder so the file
is immediately visible — including when a later setup step fails.

The last folder selection is remembered in browser storage per normalized
signed-in email. It is a convenience value, not an authorization decision; it is
never stored in a workbook, and it does not follow the manager to another
browser or device.

## Discovery

Candidates are Google Sheets files from the signed-in user's Drive corpus that
are not trashed. Drive's `name contains` query is prefix-based, so the server
applies the final case-sensitive `name.includes("勤怠管理表")` test itself after
paginating the candidate list.

- **Manager** — only direct children of the validated active folder. Descendant
  folders are not traversed. A file is listed when the signed-in account is a
  current owner and the name matches. A matching owned file without app
  configuration appears as `Needs setup`; the manager must explicitly select
  that same file through Google Picker before the application may mutate it,
  because metadata discovery alone does not grant `drive.file` access.
- **Employee** — files Drive reports in `Shared with me`, whose current owner
  email ends with `@blended-asia.com`, whose name matches, and whose protected
  configuration maps the signed-in email to exactly one existing sheet. A shared
  file without a valid mapping is not shown.

If the remembered folder is deleted, trashed, moved to a Shared Drive, or no
longer writable, the manager section shows `Folder unavailable` and requires a
new selection. It never falls back to scanning all of Drive. Employee discovery
is unaffected.

## Workbook contract

Every employee sheet uses the reference workbook's layout.

| Columns | Meaning | Web behavior |
| --- | --- | --- |
| A | Calendar date | Generated for every day of the selected month |
| B | Weekday | Derived from the date, displayed in English |
| C | Business-day sequence (`営業日`) | Maintained with the monthly template |
| D | Status (`ステータス`) | Enum-backed select control |
| E | Clock in (`出勤`) | Decimal hour in the sheet, 24-hour time on the web |
| F | Clock out (`退勤`) | Decimal hour in the sheet, 24-hour time on the web |
| G | Break (`休憩`) | Decimal hours, synchronized with the lunch rule |
| H | Work hours (`労働時間`) | Sheet formula `=F-G-E`, never client-written |
| I | Notes (`備考`) | Free text for the selected day |
| J:AS | Work report (`作業時間報告`) | 36 half-hour slots, 06:00 through 23:30 |

Row 2 holds merged two-column hour headers across J:AS (`J2:K2 = 6` through
`AR2:AS2 = 23`), row 3 holds the `D3:I3` Japanese headers and alternating `0`/
`30` minute headers across J3:AS3, and daily data starts at row 4.

Import accepts `.xlsx` only, up to 20 MB, and creates a **new** Google Sheets
file rather than merging into an existing one. Every visible non-configuration
sheet must satisfy all of the checks above and have column-A dates inside the
manager-selected month, otherwise import is blocked before anything reaches
Drive and the UI lists each failing sheet and check. An `__APP_CONFIG` sheet
carried inside an upload is not trusted; setup replaces it with the current
schema. If Drive converts the file but a later setup step fails, the file is
kept and the manager gets a resume action — it is never auto-deleted.

Generated files write the column-H formula for applicable rows instead of
hard-coding calculated values.

## Time and work hours

- The sheet stores clock values as decimal hours: `8` is 08:00 and `17.5` is
  17:30. The web converts to and from 24-hour display strings.
- Clock in, clock out, break, and work-block boundaries use 30-minute steps.
- `workHours = clockOut − break − clockIn`, matching the sheet's `=F-G-E`.
- Clock out must be later than clock in; break cannot be negative or exceed the
  clocked duration; a negative work-hour result is rejected before Save.

## Lunch

The day editor has an English checkbox labelled `Lunch break · 12:00–13:00`.

When it is selected, the 12:00 and 12:30 slots are reserved and reject work
text, a work block crossing lunch skips those two slots, break hours are set to
`1`, and work hours are recalculated. Existing text in those two slots is
cleared only as part of an explicitly confirmed Save. When it is cleared, both
slots become editable again and break hours may be entered manually.

## Status

Status is an enum-backed select; the web never writes free-form status text.
The initial template ships two values:

| Web label | Stored sheet value |
| --- | --- |
| Office | `出社` |
| Absent | `欠勤` |

The `__APP_CONFIG` sheet stores the code, English label, and raw sheet value for
each status, so a future template can extend the enum without changing the
attendance page's component contract.

## Notes

Notes are free text scoped to a single day. They map to column I (`備考`) and
save together with the other changed fields for that day.

## Editing and saving

The attendance page drives one in-memory day model through two editors that stay
in sync: a timeline of 30-minute slots, and a work-block editor whose start and
end accept `:00` and `:30` boundaries over a half-open interval `[start, end)` —
09:00–10:00 writes 09:00 and 09:30 but not 10:00. Applying a block writes the
same description into every covered non-lunch slot, and an overlapping block
must show which cells it will replace before it is applied.

The page also carries status, clock in, clock out, break, calculated work hours,
the lunch control, daily notes, dirty-state indication, and an explicit
`Save to Google Sheets` action.

Save sends only the changed cells. It never rewrites a whole employee sheet or a
whole day row when a subset changed, and different-cell concurrent edits do not
justify a whole-row write. Same-cell concurrency is last-writer-wins in the
first version and is disclosed in the UI when the source changed since load. A
failed Save preserves the unsaved edits and offers Retry or Re-authenticate.

## Access

Sign-in is Google OAuth. All Drive and Sheets calls run server-side under the
signed-in user's own authority, using identity scopes plus Sheets read/write,
`drive.file`, and `drive.metadata.readonly`.

Every server mutation independently takes the normalized email from the verified
server session, re-reads current Drive ownership and access metadata, re-reads
the file's protected mapping, authorizes the requested role, and restricts
employee writes to the mapped sheet and approved ranges.

The spreadsheet itself is protected as well: `__APP_CONFIG` is owner-only, and
each employee sheet is protected with the owner and the mapped employee as
permitted editors. Employees hold Drive writer permission so they can save under
their own identity. Protection prevents edits to other tabs but does not hide
them from view — an accepted limitation of this design.

Application secrets live in a gitignored `.env`. Client secrets and refresh
tokens never reach browser JavaScript or a `NEXT_PUBLIC_` variable; per-user
tokens live in encrypted, HttpOnly, Secure session state. Browser storage holds
only the last dashboard folder ID and display name. Revoked or expired
authorization sends the user through re-consent without discarding unsaved form
data where that is technically possible.

## All text is English

Default site text, actions, validation messages, empty states, and errors are in
English. Dates use readable English labels and times use the 24-hour clock.
Japanese strings survive only inside the sheet integration contract, where the
reference workbook requires them.
