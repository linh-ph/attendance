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

A candidate whose contents cannot be read this request — a Sheets outage, a
throttle, a revoked grant — is **named** rather than dropped. Discovery returns
it in `unreadable`, and the browser says how many files could not be read
instead of showing an empty list. An empty list now means "you have none"; it no
longer also means "Google could not be reached".

## The calendar

The dashboard opens on a month calendar, which loads itself in three steps:

1. this browser's stored copy of the month is drawn first, so the grid is not a
   blank wait;
2. the authorized file list is fetched in the background;
3. the current month is read from Google Sheets and replaces the stored copy.

Each date shows `Recorded` or `Not recorded` — the same two-value rule the day
editor uses, carried by a word and a shape as well as a colour — plus whether it
is a non-working day, and `Today` when the spreadsheet reports a timezone.

The calendar never guesses which file to open. Exactly one authorized file for
the month opens directly; several require an explicit choice; a file with no
configuration asks which tab is yours. When no file covers the month, the
calendar says which month it looked for and offers the two things that help:
pick another month, or create the file and press `Load files`.

A failure is never shown as an empty month. `Offline`, an expired session, and a
Google fault each get their own message and recovery step, and the stored copy
stays on screen and usable.

## Syncing to this browser

`More → Data and sync → Sync now` re-reads the current month from Google Sheets
into this browser's copy and reports what it stored: the month, the timesheet,
how many dates it holds, how many are recorded, and how many working days are
still empty.

Google Sheets remains the only source of truth. The browser copy is a head
start, never an authority: the server re-reads the sheet and re-authorizes every
request, and no authorization result is ever stored. A sync that read the sheet
but could not write the local copy says exactly that rather than reporting
`Synced`.

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
must show which cells it will replace before it is applied. The block opens on
the standard working day, 08:00 to 17:00, so the ordinary case needs only a
description.

One day can be copied onto others. `Apply this day to other days` opens a
calendar of the month: click a day to include it, or drag across several. A
drag is a working-week gesture and skips the weekend it crosses; a weekend
included by hand is kept, because clicking a Saturday says somebody worked it.
The day being copied is never a target.

Applying replaces rather than merges, so the days that already hold something
are counted and named before anything is written. Each day is then written
through the ordinary per-day save — authorized, validated, and conflict-checked
exactly like a hand-typed day — one at a time, and a failure stops there and
reports how many were written rather than claiming the whole run.

A created tab is laid out like the workbook the team already keeps: Arial, the
reference file's column widths, and the first three rows and two columns frozen.
That file uses no fills and no borders, so neither is invented here. Tabs are
created **open** — no protected range is added to an employee sheet, and the
person creating a file gets a tab of their own, because whoever sets the month
up records hours in it too.

The page also carries status, clock in, clock out, break, calculated work hours,
the lunch control, daily notes, dirty-state indication, and an explicit
`Save to Google Sheets` action.

Save sends only the changed cells. It never rewrites a whole employee sheet or a
whole day row when a subset changed, and different-cell concurrent edits do not
justify a whole-row write. Same-cell concurrency is last-writer-wins in the
first version and is disclosed in the UI when the source changed since load. A
failed Save preserves the unsaved edits and offers Retry or Re-authenticate.

Unsaved edits are also mirrored into this browser's `attendance-local`
IndexedDB database, so they survive a reload, a dropped connection, or a closed
tab. Because every edit is mirrored under its own date before anything else
happens, moving between days never stops to ask: the day being left is already
in storage and is restored when it is opened again. "Unsaved" means unsaved to
Google Sheets, which the badge beside Save reports. A stored draft carries the sheet row it was made against and is re-applied
only onto an identical row: if the sheet changed while the draft sat in
storage, the draft is discarded rather than replayed over the newer data. The
record is removed as soon as the day is saved or the changes are discarded. The
last loaded month is cached the same way so reopening a sheet renders before
the network answers; the cache is only ever a head start and is replaced by the
live read.

The browser also keeps a **member roster** — colleagues with a name and an
address — so creating next month's file does not mean retyping them. `Members`
on the dashboard manages it: type one, remove one, or import from Drive.

The import is the only part that asks Google anything. Listing a Workspace needs
the Admin SDK and an administrator, which this app has neither of; instead
`permissions.list` reports who else can reach each attendance file the signed-in
account can already open, and those people are offered as suggestions. Only
`user` grants become people — `anyone` and `domain` name nobody, and a group
address cannot own a tab — and a file whose sharing list cannot be read is
skipped rather than failing the import. Nothing is added until it is chosen.

At the Members step of `Create a monthly file`, the roster appears as
shortcuts: choosing one fills a member row that can still be edited or removed,
and anyone already on the draft stops being offered. The roster suggests; it
grants nothing, and every file operation is authorized on its own.

When the file is created, it opens on the creator's own timesheet — the month
exists so hours can go into it, and the roster was reviewed a step earlier. A
manager who removed their own row has no tab to open, and lands on
`Manage members` instead.

Every browser-local record is keyed by the normalized signed-in email, so two
accounts sharing a browser profile cannot see each other's. These records
deliberately outlive sign-out, which means a shared machine keeps one person's
work-hour drafts until that browser profile is cleared. Nothing stored locally
is authoritative and no token or authorization result is ever kept there.

## Files this app never configured

An attendance file does not have to be set up before it can be used. Any file
the signed-in account can reach through Drive is listed, including files in a
Shared Drive, whoever owns them.

Where a configuration exists it still takes the person straight to their own
tab. Where it does not, the app reads the tab from the signed-in address: the
tabs are titled with employees' full names and the work address is built from
that same name, so `linh.np@blended-asia.com` resolves to `NGUYEN PHAN LINH`
and the timesheet opens without a further step. Two spellings are understood —
given name plus the initials before it (`linh.np`), and the whole name in any
order (`nguyen.phan.linh`).

An address that names no tab, or more than one, opens nothing: the file offers
its tab list and the person picks the one that holds their hours. Appending
`?choose=1` to the file's attendance URL always shows that list, for anyone
whose tab is not the one their address spells. The month comes from the file
name and the status list from the workbook defaults.

Neither path is an access decision — Google decides what the write may do,
exactly as it does when the same person opens the file in Google Sheets.

This app therefore adds no restriction of its own on who may edit which tab.
That is a Google Sheets sharing concern; if per-tab isolation is wanted, it
comes from protected ranges on the file.

## Opening a file

Besides the dashboard cards, a file can be opened by pasting its Google Sheets
link, and the sheets opened most recently on this browser are offered as links.

The link is a shortcut, not a way in. It resolves only against the files this
dashboard already listed for the signed-in user — a listing the server computed
after authorization — so a link to anything else reports plainly that the user
has no permission for it, or is not set up for attendance yet, and navigates
nowhere. Any `gid` in the link is discarded: an employee is always taken to the
sheet the configuration maps them to, never to a tab named in a URL. The
destination re-authorizes the request regardless.

Choosing a legacy file in Google Picker to start setup is unchanged and still
required: picking a file that this manager does not manage reports a permission
problem rather than unlocking setup, and picking a different file they do
manage still asks for that same file.

## Access

Sign-in is Google OAuth. All Drive and Sheets calls run server-side under the
signed-in user's own authority, using identity scopes plus Sheets read/write,
`drive.file`, and `drive.metadata.readonly`.

Every server mutation independently takes the normalized email from the verified
server session, re-reads current Drive ownership and access metadata, re-reads
the file's protected mapping, authorizes the requested role, and restricts
employee writes to the mapped sheet and approved ranges.

Inside the spreadsheet only `__APP_CONFIG` is protected, and only for the owner:
it is app metadata rather than anybody's timesheet. Employee tabs are created
open. Employees hold Drive writer permission so they can save under their own
identity, and who may edit which tab is a Google Sheets sharing question, not
one this app answers.

Creating a file offers one choice about the world outside it: **Email each
member that the file is shared**, on the review step, ticked by default. The
sharing happens either way — the file appears in every member's own Drive — so
clearing it withholds only Google's notification message, not access. Importing
a workbook and adding a member to a live file always notify.

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
