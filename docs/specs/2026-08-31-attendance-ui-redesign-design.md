# Attendance UI Redesign — Product and Interaction Design

Date: 2026-08-31
Status: Approved in conversation; pending written-spec review

## 1. Outcome

Redesign the attendance website into a calm, modern, responsive workspace whose
primary surface is a monthly attendance calendar. The redesign must make the
daily workflow fast for an employee, keep management work discoverable for a
manager, and communicate clearly whether a change exists only in the browser or
has reached Google Sheets.

The approved direction is **Calm productivity**: airy layouts, strong hierarchy,
indigo as the primary action color, mint for successful states, restrained
shadows, and readable tabular time values. It applies equally to desktop and
mobile.

This document supersedes the presentation and interaction portions of the
existing attendance design where they conflict. It does not replace the
workbook contract, Google authorization boundaries, validation rules, or other
security requirements in
[`2026-08-28-google-sheets-attendance-design.md`](2026-08-28-google-sheets-attendance-design.md).
Google Sheets remains the authoritative data source. IndexedDB is a
browser-local cache and draft store, never an authorization or ownership
source.

## 2. Approved decisions

### 2.1 Product shape

- Use one **unified workspace**. A user who is both employee and manager does
  not switch roles or modes.
- Make the monthly attendance **calendar the dashboard's primary content**.
- Keep employee work first in the hierarchy. Management modules remain visible
  below or beside it without competing with the daily primary action.
- Design the entire website consistently: login, calendar dashboard, day
  editor, timesheets, managed files, members, create/import/setup wizards, and
  all loading, empty, error, offline, and conflict states.
- Support phone and desktop as equal product surfaces. Mobile is not a reduced
  desktop screenshot; its navigation, sheets, sticky actions, and content
  order adapt to touch use.

### 2.2 Visual direction

The visual foundation uses:

- dark navy ink (`#19213B`) on a cool paper canvas (`#F6F7FC`);
- indigo (`#5868E8`) for selected navigation and primary actions;
- mint washes for successful or synchronized states;
- amber for missing, pending, or attention states;
- red only for destructive, failed, or conflict states;
- 12–18 px component radii, subtle one-pixel borders, and restrained elevation;
- a system sans/Noto Sans-compatible type stack;
- tabular numerals for dates, times, durations, and counts;
- an 8 px spacing grid with denser substeps where compact controls require it.

Color never carries state by itself. Every state also has text, an icon or
shape, and an accessible name.

### 2.3 Login artwork

The login page retains the existing [`public/meme.jpeg`](../../public/meme.jpeg)
image selected by the product owner.

- Desktop shows the complete image in the right-hand visual panel.
- Mobile also shows the same complete image above the login message in a compact
  frame.
- The image keeps its original aspect ratio and uses `object-fit: contain`; it
  must not be cropped merely to fill the frame.
- The image remains decorative (`alt=""`) unless a later content decision gives
  it information needed to use the product.
- Framing, background, radius, and shadow may change to fit the redesign, but
  the image content itself must not be edited or replaced.

## 3. Information architecture

### 3.1 Desktop shell

At desktop widths, use a persistent left sidebar:

1. Calendar
2. Timesheets
3. Managed files
4. Members
5. Signed-in identity and Sign out at the bottom

Calendar and Timesheets are the employee-first workspace. Managed files and
Members form a visually labeled Management group. Management navigation remains
available rather than inventing a global manager capability: ownership is
defined per file, creating a new file is separately authorized, and every route
and mutation continues to re-authorize its own operation.

### 3.2 Mobile shell

Use a four-item bottom navigation with minimum 44 px targets:

1. Calendar
2. Timesheets
3. Manage
4. More

`Manage` opens Managed files by default and provides Members as a sibling
destination. `More` owns account details and Sign out. No new Help or Settings
destination is introduced by this redesign. Page titles and module names remain
the same as desktop so users do not have to learn two structures.

### 3.3 Context selection

The calendar always identifies the active monthly file and employee sheet. Its
automatic candidates are exactly the server-authorized `timesheets` returned by
dashboard discovery, not every manager-owned file:

- one mapped candidate for the current month opens directly;
- zero candidates shows `No timesheet for this month` and offers the existing
  authorized file-selection/opening paths;
- multiple candidates for the same month require an explicit file/sheet choice;
- an unconfigured legacy file follows the existing email-to-tab match and tab
  chooser before it becomes a calendar context;
- a manager opening another member's tab does so from Managed files and that
  context may appear in Recent files, but it does not become the manager's own
  timesheet candidate;
- a remembered last context is a per-account browser convenience and is
  re-authorized before use.

Each month remains a separate file. Previous/next month navigation only moves
to an authorized candidate with that month. If none exists, the control is
disabled; duplicate candidates never cause the application to guess.

### 3.4 Timesheet utilities

The redesign preserves **Open by link** and **Recent files**. They move to the
Timesheets page as secondary utilities so the Calendar dashboard can remain
focused. Desktop shows Recent files below the timesheet list and Open by link in
a compact utility panel. Mobile shows the same sections after the current
timesheets, with Open by link collapsed until requested.

Their security behavior does not change: pasted links resolve only against
server-authorized dashboard results, URL `gid` never bypasses mapped-tab
selection, and every destination re-authorizes. Recent files remain
account-scoped browser convenience records and never grant access.

## 4. Calendar dashboard

### 4.1 Month view

The calendar is the dashboard's dominant surface. It shows one attendance month
at a time and provides previous month, next month, and Today controls only when
the relevant monthly files exist.

`Today` is derived from the selected spreadsheet's IANA timezone returned by
`spreadsheet.properties.timeZone`. It is recomputed when the file context
changes. The application must not use UTC or the browser/device timezone for
this decision. If the timezone is missing or invalid, the calendar remains
navigable but disables Today and reports that the spreadsheet timezone could
not be determined instead of guessing.

Each date can expose the following orthogonal states:

- **Recorded** — at least one attendance value exists for the day, matching the
  existing definition used by the attendance calendar.
- **Not recorded** — no status, clock-in value, clock-out value, non-zero break,
  notes, or work-report slot exists.
- **Non-working day** — weekend or another non-working day supplied by the
  calendar/workbook context.
- **Selected** and **Today** — navigation states layered on top of the attendance
  state.
- **Local changes** — this browser has a draft not yet synchronized to Google
  Sheets.
- **Needs attention** — validation, remote-change, or failed-sync state.

The implementation must not label a day `Complete` until product rules define
what completion means for every configured status, including Absent. The
approved interaction needs Recorded versus Not recorded; a future completion
policy is separate product authority.

Desktop cells may show a compact duration when available. Mobile cells use
short labels and state markers to preserve a usable hit area. A persistent
legend explains all visible markers.

### 4.2 Day quick preview

The approved interaction is **quick preview plus full detail**.

- Clicking or activating a date on desktop opens a popover anchored to that
  cell.
- Tapping a date on mobile opens a bottom sheet.
- The preview is read-only. It shows the date, attendance state, clock in,
  clock out, break, work hours, notes summary, work-block summary, local/remote
  sync state, and last successful Sheet check when available.
- The primary preview action is `Open full detail`.
- The preview closes with its Close action, Escape, or an outside pointer action
  where that does not discard work. Focus returns to the date that opened it.
- The mobile bottom sheet uses dialog semantics, a clear close path, and safe
  area padding.

Viewing a preview must not mutate either IndexedDB or Google Sheets.

## 5. IndexedDB and Google Sheets data flow

### 5.1 First open

When no valid month cache exists for the signed-in account, file, sheet, month,
and schema version:

1. Show `Preparing your calendar` with a stable skeleton.
2. Read and normalize the month from the selected workbook through the existing
   server-authorized Google Sheets path. For an imported `.xlsx`, this is the
   Google Sheet produced by the approved import/conversion flow.
3. Validate the normalized month before exposing it as editable UI.
4. Attempt to write the month baseline to the account-scoped IndexedDB cache
   and wait for its acknowledged result.
5. Render the validated remote calendar and record the successful remote-check
   time. A rejected cache write does not block the remote data from rendering;
   it shows `Local storage unavailable` and the next visit fetches remotely
   again.

OAuth tokens, refresh tokens, authorization results, cookies, and provider
secrets must never enter IndexedDB.

### 5.2 Subsequent opens

Use **cache-first, background revalidation**, the approved option A:

1. Read IndexedDB and render the calendar immediately when a compatible cache
   exists.
2. State plainly that cached data is being shown and display the last successful
   Sheet check.
3. Fetch the current Sheet month in the background.
4. If the local state is clean, replace the cache and visible baseline with the
   validated remote response.
5. If the currently open day is dirty, do not replace that in-memory draft with
   a background response. Mark that the Sheet changed and retain the current
   baseline until Save, discard, or reload applies the existing concurrency
   policy. A stored draft is restored after reload only when its saved baseline
   is byte-for-byte identical to the newly read row; otherwise the stale draft
   is discarded with a notice instead of being replayed over newer Sheet data.

The cache is a head start, not a second source of truth. A failed background
check leaves the cached calendar usable and changes its state to Offline or
Needs attention with Retry/Re-authenticate actions as appropriate.

### 5.3 Editing and synchronization

Every valid edit requests a write to the date-scoped IndexedDB draft first. The
UI shows `Saved locally` only after that write has resolved successfully. If
IndexedDB is unavailable, blocked, corrupt, over quota, or cannot migrate, the
edit remains in memory and the UI shows `Local storage unavailable — keep this
page open or save to Google Sheets`; it must not claim the draft is durable.

`Save & sync`:

1. validates the complete day with the existing attendance rules;
2. sends only the changed cells through the authorized server route;
3. disables duplicate save submissions without blocking reading or scrolling;
4. on remote success, advances the in-memory baseline to the confirmed Sheet
   result, then transactionally updates the IndexedDB baseline and clears only
   the exact draft revision included in the request;
5. on failure, preserves the draft and offers Retry or Re-authenticate;
6. retains the existing same-cell last-writer-wins behavior and discloses any
   source changes reported by the save result; this redesign does not introduce
   an atomic pre-write conflict editor.

If the Sheet write succeeds but the following IndexedDB transaction fails, the
remote Save must not be repeated and the UI must not announce `Synced`. It
clears the submitted edit from in-memory pending state, keeps the confirmed
remote result as the in-memory baseline, and shows `Saved to Google Sheets ·
local cache unavailable`. `Retry local cache` may retry only the baseline/draft
transaction. Until it succeeds, the context is marked for a remote read on the
next open; any stale stored draft remains subject to the identical-baseline
restore rule and cannot be replayed over the confirmed Sheet result.

The day being edited and the matching calendar cell share the same local state,
so the calendar reflects local changes immediately.

### 5.4 Sync state vocabulary

Use the following language consistently:

| State | Meaning | Expected action |
| --- | --- | --- |
| `Synced` | IndexedDB baseline matches the last confirmed Sheet state | None |
| `Saved locally` | A valid local draft is not yet confirmed by Sheet | Save & sync |
| `Syncing` | A Sheet write is in flight | Wait; duplicate Save disabled |
| `Offline` | Remote check/write could not run; local data is intact | Continue or Retry |
| `Needs attention` | Validation, authentication, provider, or conflict issue | Follow inline recovery |
| `Remote changes detected` | Sheet moved after the current baseline | Reload/discard, or Save under the disclosed last-writer-wins policy |
| `Local storage unavailable` | The in-memory edit was not persisted to IndexedDB | Keep the page open or Save to Sheet |
| `Saved to Google Sheets · local cache unavailable` | Remote Save succeeded but the cache/baseline transaction failed | Do not Save remotely again; retry local cache or re-read on next open |

Save and sync announcements use a polite live region and do not steal focus.

### 5.5 Revalidation, Save, and multi-tab ordering

Async cache operations must obey these ordering rules:

- A file/sheet/month context owns a monotonically increasing request epoch.
  A load or revalidation response may update visible state or IndexedDB only if
  its context is still selected and its epoch is the latest issued epoch.
- Every draft has a local revision and baseline hash. A successful Save clears
  a draft only when its revision equals the revision sent; edits made while the
  Save was in flight remain pending.
- A revalidation started before a successful Save cannot replace the newer
  post-Save baseline. Cache writes compare their captured baseline/revision in
  one IndexedDB transaction before committing.
- Clean remote updates may merge by date. A response never replaces a dirty
  date in memory; it records that the remote row changed and leaves Save/reload
  to the existing concurrency policy.
- Tabs editing the same account/file/sheet/date broadcast revision changes and
  use the same transactional revision comparison. A stale tab must re-read or
  surface `Remote changes detected`; it cannot clear or overwrite a newer local
  draft silently.

Direct tests must cover a slow revalidation arriving after Save, an edit made
during Save, independent remote changes on another date, and two tabs writing
the same draft key.

### 5.6 Retention and storage failure

Pending drafts have no application TTL and are never automatically evicted.
Clean month caches also have no application TTL in this redesign. Both continue
to outlive sign-out under the current product policy and remain until the
browser/profile clears or evicts site data or an explicitly approved future
clear-data feature removes them. A schema migration may replace a clean cache,
but must preserve or safely refuse incompatible pending drafts rather than
deleting them silently.

All cache/draft APIs return an acknowledged success or failure to their caller.
A cache miss or rejected clean-cache write falls back to the remote load path.
A rejected draft write produces `Local storage unavailable` and retains the
in-memory draft for direct Save; storage failures must not be converted into a
false `Saved locally` state.
A rejected post-Sheet-save transaction advances the confirmed in-memory
baseline, returns the composite `Saved to Google Sheets · local cache
unavailable` state, and must not trigger a second Sheet write.

## 6. Day editor

The full day editor keeps the current domain capabilities while changing their
hierarchy.

### 6.1 Desktop

- Header: Back to calendar, readable date, file/member context, previous day,
  Today, next day, and last Sheet check.
- First column: Day summary — configured status, clock in/out, break, calculated
  work hours, lunch control, and notes.
- Second column: Add work block and Apply this day to other days.
- Full-width lower section: visual work-report timeline and editable 30-minute
  slots.
- Sticky footer: current local/sync state and `Save & sync`.

The block editor and timeline continue to edit one shared draft. Lunch and work
hour rules remain those in the existing product specification.

### 6.2 Mobile

- Back to Calendar, date, and previous/next controls remain at the top.
- Day Summary is first and may collapse after its current state is summarized.
- Work blocks become readable stacked cards; the detailed timeline is
  horizontally scrollable or opens a focused slot editor without shrinking
  touch targets.
- `Add work block` remains close to the work-block list.
- A safe-area-aware sticky footer shows local/sync state and `Save & sync`.

The mobile editor must never put the entire long form inside the calendar bottom
sheet. That sheet remains a quick, read-only preview.

## 7. Management and wizard system

### 7.1 Management hub

Managed files uses the active folder as visible context and presents files in a
scannable list/table with:

- file name and modified time;
- attendance month;
- Ready, Needs setup, Needs repair, or unavailable status;
- member count or setup progress;
- one clear next action, such as Open, Resume, or Repair.

`Create monthly file` is the primary management action. `Import XLSX` is a
secondary action. Search and status filters may reduce the visible list but
must not change discovery or authorization rules.

### 7.2 Members

Members remains a browser-local, signed-in-account-scoped roster. Desktop uses
a compact table/list with search and an Add member action. Mobile uses readable
member cards. Import from Drive remains an explicit action and does not add
anyone until selected.

The roster is a convenience source for wizard fields. It does not grant Drive
access and is never treated as file membership authority.

### 7.3 Shared wizard grammar

Create, Import, and legacy Setup share:

- an explicit title and purpose;
- a desktop step rail and compact mobile progress indicator;
- one principal task per step;
- field-level and item-level validation beside the source of the problem;
- a sticky Back/Continue or Save action row;
- a desktop live summary and a mobile review step;
- review before any Drive mutation;
- a progress/recovery surface after mutation begins;
- Resume for retained files after partial setup failure.

Create keeps the approved Details → Members → Review → Setup sequence. Import
keeps XLSX upload → workbook preflight → output details and sheet-owner mapping
→ review/save → setup. Preflight must list the sheet and rule responsible for
each failure before Drive is changed.

## 8. Login and system states

### 8.1 Login

Login uses one primary `Continue with Google` action. It explains that the user
signs in with a blended-asia Google Workspace account, the application operates
under that user's Drive permissions, and there is no separate password.

Desktop is a split layout with message/action on the left and the retained image
on the right. Mobile stacks brand, retained image, message, Google action, and a
short trust cue. The primary action must remain visible without excessive
scrolling on a common 390 × 844 viewport.

### 8.2 Required reusable states

The component system must cover:

- first remote load;
- cached render while revalidating;
- local storage unavailable while an edit remains only in memory;
- no timesheet/current month;
- no managed files;
- no members;
- folder unavailable;
- offline with local data safe;
- local changes pending sync;
- remote changes detected;
- authentication expired;
- provider/Google API failure;
- partial create/import/setup with Resume;
- unsupported or invalid workbook.

Each state answers: what happened, whether data is safe, and what to do next.
Page-level failures use page-level recovery; one broken file remains a card/row
error and does not fail the whole dashboard.

### 8.3 Debug diagnostics

Normal mode shows concise, actionable English errors. When the existing
server-side `APP_DEBUG_ERRORS=1` switch is enabled, error surfaces may expose a
collapsed `Technical details` section containing the original allowlisted
provider diagnostic fields.

The only permitted browser envelope is the existing `GoogleErrorDiagnostic`
shape: `name`, `message`, numeric-or-null `status`, `providerMessage`,
`providerStatus`, and `providerReason`. Each string is sanitized and length
capped independently; a field is `null` when the gateway cannot prove it is
safe. Unknown provider fields, response/request bodies, headers, URLs with
query strings, arbitrary Error objects, and stack traces are excluded.

Debug mode must still redact application secrets, OAuth client secrets, access
and refresh tokens, cookies, authorization headers, request payloads, encoded
credentials, and unlabeled exact secret values before serialization. Debug API
responses use `Cache-Control: no-store`, diagnostics are never persisted to
IndexedDB, and debug UI remains absent when the switch is off. Negative tests
cover labeled, unlabeled, URL-encoded, and base64-shaped representative secrets;
if a provider message cannot meet this boundary it is omitted rather than
returned verbatim.

## 9. Responsive and accessibility requirements

- Target WCAG 2.2 AA contrast for text and interactive states.
- All workflows must be keyboard complete.
- Calendar supports arrow-key date movement, Enter/Space activation, a visible
  focus ring, and correct selected/today/state announcements.
- Popovers and bottom sheets have an accessible name, predictable dismissal,
  and focus restoration.
- Mobile pointer targets are at least 44 × 44 CSS px.
- Do not use hover as the only path to attendance detail or an action.
- Respect `prefers-reduced-motion`; no meaning depends on animation.
- Loading skeletons reserve final layout dimensions and stop animating for
  reduced motion.
- Error text is linked to invalid fields with `aria-describedby`; the first
  invalid field receives focus only after a submitted step fails.
- Status messages use live regions without moving keyboard focus.
- Dates are exposed as full readable dates even when the visual cell shows only
  a day number.
- Time and duration values remain legible at 200% zoom without horizontal page
  overflow. A timeline may scroll inside its own labeled region.

## 10. Component boundaries

The redesign should consolidate shared behavior rather than duplicate screens:

- `AppShell` owns desktop/sidebar and mobile/bottom navigation.
- `MonthCalendar` owns visual date state and keyboard navigation.
- `DayQuickPreview` renders as an anchored popover or bottom sheet through one
  content contract.
- `AttendanceCache` owns account/file/sheet/month/schema IndexedDB keys,
  baseline metadata, acknowledged writes, revisions, drafts, and migrations.
- `SyncStatus` owns the approved vocabulary and live announcements.
- `DayEditor` continues to own one reducer-driven draft shared by summary,
  block, and timeline editors.
- `WizardShell` owns steps, sticky actions, review summary, and recovery slots;
  feature wizards own their data and validation.
- `ErrorNotice` owns recovery actions and optional sanitized debug disclosure.

These names describe responsibilities, not mandatory filenames. Implementation
must adapt them to existing repository ownership and tests.

## 11. Validation and acceptance criteria

### 11.1 Visual and responsive

- Login preserves the complete existing image on desktop and mobile.
- Calendar is the dominant dashboard element at desktop and 390 px mobile.
- Sidebar and bottom navigation expose the same information architecture.
- Timesheets preserves Open by link and Recent files on desktop and mobile.
- Day preview is a desktop popover and mobile bottom sheet.
- Sticky actions do not cover content or platform safe areas.
- No horizontal page overflow occurs at 320, 390, 768, 1024, and 1440 px;
  separately labeled timelines may scroll internally.

### 11.2 Data behavior

- A cache miss fetches and validates the remote month, attempts an acknowledged
  IndexedDB write, and renders the remote result even if that cache write fails;
  the failure is disclosed and IndexedDB never becomes authoritative.
- A cache hit renders without waiting for the network and starts background
  revalidation.
- Clean remote changes refresh IndexedDB and the UI.
- `Saved locally` appears only after the date-scoped draft write succeeds.
- IndexedDB failure keeps the in-memory edit, shows `Local storage unavailable`,
  and still permits direct Save to Sheet.
- Successful Save updates the cache baseline and clears the pending draft.
- When Sheet Save succeeds but its IndexedDB transaction fails, the UI advances
  the in-memory baseline, reports `Saved to Google Sheets · local cache
  unavailable`, does not report `Synced`, and a cache retry performs no remote
  mutation.
- Failed/offline Save keeps the draft and exposes recovery.
- A stale stored draft is restored only onto an identical remote baseline;
  otherwise it is discarded with a notice under the current product policy.
- Same-cell concurrent Save remains last-writer-wins and discloses source
  changes returned by the server.
- A pre-Save revalidation cannot overwrite a post-Save baseline, and edits made
  during Save are not cleared.
- Multi-tab draft races detect a stale revision rather than silently clearing or
  overwriting the newer local draft.
- No credential or authorization material is stored in IndexedDB.
- Pending drafts and clean month caches have no application TTL and are not
  automatically removed on sign-out.

### 11.3 Interaction and accessibility

- Calendar status, date selection, quick preview, and full editor navigation are
  covered by component and browser tests.
- Recorded/Not recorded tests cover status, clock in, clock out, non-zero break,
  notes, and every work-report slot.
- Context tests cover zero, one, multiple, duplicate-month, manager-opened, and
  legacy-tab candidates without treating navigation state as authorization.
- Today tests use the spreadsheet IANA timezone on both sides of UTC midnight,
  after context changes, and when the timezone is missing or invalid.
- Keyboard users can complete login, choose a date, inspect it, edit it, save,
  use management lists, and complete both wizards.
- Automated accessibility checks cover landmark/name/role/value basics; manual
  checks cover focus order, screen-reader announcements, zoom, contrast, and
  reduced motion.
- Debug diagnostics appear only when the server flag is enabled, responses are
  `no-store`, the envelope contains no unknown fields, and negative redaction
  tests prove representative raw/encoded secrets do not reach the response or
  UI.

### 11.4 Existing behavior

- Current attendance validation, workbook mapping, role authorization, Google
  Picker revalidation, partial-setup recovery, and smallest-cell write behavior
  remain covered by their existing tests.
- The redesign does not broaden Drive or Sheets access and does not introduce an
  application database.

## 12. Risks and non-goals

### Risks

- A stale cache could look authoritative. Mitigate with explicit last-checked
  state and automatic background revalidation.
- Month-level caches can grow across many files. This version deliberately does
  not auto-delete them because no retention policy has been approved; browser
  storage pressure is surfaced as cache/draft write failure rather than hidden.
- A dense calendar can become unreadable on narrow screens. Keep cell content
  minimal and move detail into the approved bottom sheet.
- Remote-change reconciliation is more complex than blind last-writer-wins.
  This redesign retains the existing last-writer-wins/disclosure policy; request
  epochs and local revisions must still prevent older async work from replacing
  a newer baseline.
- Shared-machine browser profiles retain local attendance records by current
  product decision. The UI must not imply that Sign out clears them.

### Non-goals

- Replacing Google Sheets as the source of truth.
- Adding a server-side application database.
- Changing the workbook schema or attendance calculation rules.
- Adding Workspace Admin SDK directory access.
- Changing Drive ownership, sharing, or authorization policy.
- Editing or replacing the retained login image.
- Defining a new business meaning for a `Complete` day beyond the approved
  Recorded/Not recorded distinction.

## 13. Design approval record

- Scope: design system and shell, core login/dashboard/timesheet flows, and all
  management/setup surfaces.
- Responsive priority: phone and desktop equally.
- Visual direction: A — Calm productivity.
- Information architecture: A — Unified workspace, no role switch.
- Dashboard priority: attendance calendar and the current day context.
- Day interaction: A — quick preview plus full detail.
- Data freshness: A — IndexedDB-first render with Google Sheet background
  revalidation.
- Today timezone: A — the selected spreadsheet's IANA timezone.
- Day editor, management/wizard system, error states, and accessibility section:
  approved.
- Login image: retain the existing image on both desktop and mobile.
