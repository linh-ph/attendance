# Execution Plan: Attendance UI Redesign — Parallel Agent Task Breakdown

Date: 2026-08-31

## Status

Active

## Outcome

The attendance website is rebuilt to the approved **Calm productivity**
direction: a calendar-first unified workspace with a desktop sidebar and a
mobile bottom navigation, a cache-first/revalidating data flow with an honest
sync vocabulary, and a consistent design system across login, calendar, day
editor, timesheets, managed files, members, and all three wizards — on phone and
desktop equally.

The work is partitioned so that **up to eight agents implement screens
concurrently** without editing the same file.

## Context

Authority, in order:

1. [`docs/specs/2026-08-31-attendance-ui-redesign-design.md`](../../specs/2026-08-31-attendance-ui-redesign-design.md)
   — the approved presentation/interaction contract. **This plan implements it
   and adds no product decision of its own.**
2. [`docs/specs/2026-08-28-google-sheets-attendance-design.md`](../../specs/2026-08-28-google-sheets-attendance-design.md)
   — workbook contract, validation, authorization. Unchanged by this work.
3. [`docs/decisions/2026-08-29-app-is-a-sheets-client.md`](../../decisions/2026-08-29-app-is-a-sheets-client.md)
   — Google's sharing is the authorization boundary.
4. [`CLAUDE.md`](../../../CLAUDE.md) — invariants and commands.

Approved visual mockups, in
[`docs/design/2026-08-31-attendance-ui-redesign/`](../../design/2026-08-31-attendance-ui-redesign/)
(read the one named in your task; they are the pixel authority where the spec is
silent). They were produced during the approved brainstorm and are **checked in
deliberately**: `.brainstorm/` is gitignored, so an agent working in its own
worktree would otherwise have no visual authority at all.

| Mockup | Covers |
| --- | --- |
| `dashboard-foundation.html` | Visual foundation, unified dashboard, sidebar/bottom nav |
| `calendar-detail-interaction.html` | Month grid, day states, **option A** quick preview |
| `calendar-day-editor.html` | Calendar → day editor transition, editor layout |
| `management-wizards.html` | Managed files hub, members, shared wizard shell |
| `login-states-photo-responsive.html` | Login (retained image, desktop + mobile), state gallery, debug disclosure, a11y foundation |

Where a mockup and the written spec disagree, **the spec wins** — the mockups
are exploration output, and only the spec was reviewed as a contract.

## Scope

In scope:

- Presentation, interaction, navigation, responsive behavior, and accessibility
  for every existing screen.
- The IndexedDB cache/draft contract required by spec §5 (acknowledged writes,
  epochs, revisions, transactional baselines, multi-tab safety).
- Reading `spreadsheet.properties.timeZone` so `Today` is the sheet's day.
- The sync-state vocabulary, reusable state gallery, and sanitized debug
  disclosure.

Out of scope (spec §12 non-goals — a task that needs one of these must stop and
report instead of implementing it):

- Replacing Google Sheets as the source of truth; adding any server database.
- Changing the workbook schema, attendance calculation, or lunch rules.
- Broadening Drive/Sheets scopes or changing authorization policy.
- Editing or replacing `public/meme.jpeg`.
- Defining a `Complete` day beyond Recorded / Not recorded.

## Approach

### The partitioning rule

Parallelism here is limited by **file ownership**, not by ideas. Today six
global stylesheets and one shell layout are shared by every screen, so eight
agents editing screens would collide on all of them.

Therefore **F1 runs alone first** and mechanically splits the stylesheets into
one exclusively-owned file per surface, publishes the token/primitive contract,
and pre-registers every new stylesheet in `src/app/layout.tsx`. After F1, no two
tasks in the same wave touch the same file, and `src/app/layout.tsx` is frozen
for the rest of the project.

### Waves

```text
Wave 0   F1 design foundation + CSS split        (alone, blocking)
         F3 AttendanceCache        ┐ no CSS — may start immediately,
         F4 timezone + day state   ┘ in parallel with F1

Wave 1   F2 AppShell · F5 SyncStatus/ErrorNotice/states · F6 WizardShell
         (3 agents, parallel, after F1)

Wave 2   S1 login · S2 calendar · S3 timesheets · S4 day editor ·
         S5 managed files · S6 members · S7a create wizard ·
         S7b import + legacy setup wizard
         (8 agents, parallel)

Wave 3   V1 responsive sweep · V2 accessibility · V3 e2e + docs
         (3 agents, parallel)

Gate     integrator: docker compose run --rm app npm run verify, then e2e
```

### Agent working agreement (every task)

- Work in your own git worktree on branch `redesign/<task-id>-<slug>`; branch
  from the integration branch, never from another task's branch.
- **Edit only the files listed under "Owns".** If you need a change in a file
  you do not own, stop and report it to the integrator — do not edit it, and do
  not duplicate its contents.
- TDD per `CLAUDE.md`: write the failing test, prove RED, then implement. When
  RED is only "module not found", mutate the implementation to prove the
  assertions bite. Tests are colocated as `src/**/*.test.ts(x)`.
- Commands are Docker-first. **Never run `npm` on the host.**
  `docker compose run --rm app npm run verify` — capture status with
  `; echo "EXIT=$?"`, never through a pipe ending in `grep`/`tail`.
- Files stay under 800 lines (200–400 typical). Split rather than grow.
- Lint bites: no `setState` in an effect body (use a promise continuation with a
  cancellation guard); use `next/link` for static internal routes.
- Use only the tokens and primitive class names published by F1. Do not invent a
  second palette, a second radius scale, or a private button style.
- Commit as `<type>: <description>`. Report facts and limits; claim completion
  only with executable or observable evidence.

### Invariants no task may break

From `CLAUDE.md` — violating one is a product regression, not a style choice:

- Column H holds the `=F-G-E` formula and is **never written** by a save.
- Free text (column I notes, J:AS slots) is sent `RAW`; every `__APP_CONFIG`
  write is `RAW`.
- Saves write the exact dirty A1 ranges, never whole rows or sheets.
- `authorizeFile` re-reads Drive access per request; a missing config sheet is
  role `open`, not a refusal; `ownedByMe` is never required.
- Every `files.list` passes `supportsAllDrives` **and**
  `includeItemsFromAllDrives`; every `files.get` passes `supportsAllDrives`.
- `googleapis` is imported only by `src/lib/google/client.ts`.
- `attendance/*` (minus `service.ts`) and `workbook/*` stay pure.
- No token, refresh token, cookie, or authorization result reaches IndexedDB.
- Never weaken a product security check to make a browser test pass.
- Pasted links resolve only against server-authorized dashboard results; `gid`
  is discarded; the destination re-authorizes.

---

## Wave 0

### F1 — Design foundation, CSS split, and the token contract

**Blocking. Runs alone. Everything else in Wave 1 and 2 depends on it.**

Goal: replace the current Swiss/time-rail token set with the approved Calm
productivity system, and give every surface its own stylesheet.

Read: spec §2.2, §9, §10; mockup `dashboard-foundation.html` and
`login-states-photo-responsive.html` (visual and accessibility foundation
section).

Owns:

- `src/app/styles/tokens.css` (rewrite)
- `src/app/styles/primitives.css` (new)
- `src/app/styles/shell.css`, `loading.css`, `responsive.css`,
  `attendance.css`, `manage.css` (split, see below)
- new empty-but-imported `src/app/styles/{login,calendar,timesheets,members,wizard,states}.css`
- `src/app/layout.tsx` (import order) — **frozen after this task**
- `docs/patterns/ui-redesign-contract.md` (new)

Do:

1. Tokens: ink `#19213B` on paper `#F6F7FC`; indigo `#5868E8` primary; mint
   success/synced wash; amber pending/attention; red destructive/failed/conflict
   only. Radii 12–18 px, one-pixel borders, restrained elevation, 8 px spacing
   grid with denser substeps, system sans/Noto Sans-compatible stack, tabular
   numerals for every date/time/duration/count. Respect
   `prefers-reduced-motion`; motion stays on `transform`/`opacity`.
2. Primitives, each with designed hover/focus/active states and a visible focus
   ring: button variants, surface/card, state pill (**color is never the only
   carrier — every pill has text plus an icon or shape**), form field with
   `aria-describedby` error binding, skeleton that reserves final dimensions and
   stops animating under reduced motion, live-region helper, sticky action row
   with safe-area padding, ≥44 × 44 CSS px touch target utility, breakpoint
   custom properties for 320 / 390 / 768 / 1024 / 1440.
3. Split the existing stylesheets so each Wave 2 surface owns exactly one file.
   This is a **mechanical move plus a re-skin to the new tokens** — do not
   change markup or component behavior, and do not delete a rule without moving
   it. Register every file in `src/app/layout.tsx` in the order
   tokens → primitives → states → shell → per-surface.
4. Write `docs/patterns/ui-redesign-contract.md`: every token name, every
   primitive class name, the file-ownership table from this plan, and the
   breakpoint list. Wave 1 and 2 agents read only this file to know what exists.

Proof: `npm run verify` green; every existing screen still renders with no
markup change; a documented token/class inventory that later tasks can cite.

### F3 — AttendanceCache: acknowledged, versioned, multi-tab-safe

**No CSS, no UI. May start immediately, in parallel with F1.**

Goal: today `local-store.ts` "degrades to a no-op" on failure, which the spec
now forbids — a rejected write must never become a false `Saved locally`.

Read: spec §5.1–§5.6, §11.2; `CLAUDE.md` browser-storage invariants.

Owns:

- `src/lib/dashboard/local-store.ts`, `local-records.ts`
- new `src/lib/cache/*` (`attendance-cache.ts`, `keys.ts`, `revisions.ts`,
  `migrations.ts`, `epochs.ts`) — split so no file exceeds 800 lines
- their colocated tests
- an adapter that keeps the current `dashboard-client.tsx` and
  `attendance-editor.tsx` call sites compiling **without editing those files**

Do:

1. Every cache/draft API returns an **acknowledged** result — success or a typed
   failure (unavailable, blocked, corrupt, quota, migration-refused). No silent
   no-op, ever.
2. Keys are scoped by normalized account email + fileId + sheetId + month +
   schema version.
3. Records carry a baseline, a baseline hash, and a monotonic local revision.
4. A context owns a monotonically increasing **request epoch**; a load or
   revalidation result may touch visible state or IndexedDB only when its
   context is still selected and its epoch is the latest issued.
5. Post-save commit is one transaction: advance the baseline and clear **only**
   the draft revision that was sent. Edits made while the save was in flight
   stay pending.
6. A pre-save revalidation may not replace a post-save baseline — compare the
   captured baseline/revision inside the transaction before committing.
7. Multi-tab: broadcast revision changes; a stale tab detects a stale revision
   and surfaces `Remote changes detected` rather than clearing or overwriting a
   newer draft.
8. Migrations may replace a clean month cache but must preserve or safely refuse
   incompatible pending drafts — never delete them silently. No application TTL
   on drafts or clean caches; both survive sign-out (current product policy).
9. Restore a stored draft only onto a byte-for-byte identical baseline;
   otherwise discard it with a notice.
10. Nothing resembling a token, cookie, or authorization result is storable —
    prove it with a test.

Proof (spec §5.5 requires these four directly): a slow revalidation arriving
after Save; an edit made during Save; an independent remote change on another
date; two tabs writing the same draft key. Plus a rejected write producing a
typed failure rather than a false success.

### F4 — Spreadsheet timezone and the Recorded/Not-recorded rule

**Server + pure domain. No CSS. May start immediately, in parallel with F1.**

Goal: `Today` is the selected spreadsheet's day, and "does this date have
anything in it" has one definition.

Read: spec §4.1, §11.3.

Owns:

- `src/lib/google/sheets-gateway.ts` (fetch `spreadsheet.properties.timeZone`)
- `src/lib/attendance/service.ts` (expose it on the month view)
- `src/app/api/files/[fileId]/attendance/[sheetId]/route.ts` (surface it)
- new `src/lib/attendance/day-state.ts` (pure)
- new `src/lib/attendance/zone.ts` (pure IANA validation + `todayInZone`)
- their colocated tests

Do:

1. Read `spreadsheet.properties.timeZone`; validate it as IANA. When missing or
   invalid, return `null` — the calendar must stay navigable, disable `Today`,
   and report that the timezone could not be determined. **Never fall back to
   UTC or the device timezone.** Note: the current code formats with
   `timeZone: "UTC"` in `attendance-labels.ts` and `dashboard-client.tsx`;
   those call sites are re-pointed by S2/S4, not by this task.
2. `dayRecordState(day)` → `recorded | not-recorded`, where *not recorded* means
   no status, no clock-in, no clock-out, no non-zero break, no notes, and no
   work-report slot. Test every one of those six carriers independently.
3. Expose the non-working-day source (weekend / workbook context) the calendar
   needs. Do **not** invent a `Complete` state.
4. Recompute-on-context-change is the consumer's job; this task provides a pure
   function and the value.

Proof: tests on both sides of UTC midnight, after a context change, and with a
missing/invalid timezone. `attendance/*` stays pure — no I/O, no Google types.

---

## Wave 1 — after F1

### F2 — AppShell: desktop sidebar and mobile bottom navigation

Read: spec §3.1, §3.2, §9, §10; mockup `dashboard-foundation.html`.

Owns:

- `src/app/(authenticated)/layout.tsx`
- new `src/components/app-shell/*`
- `src/app/styles/shell.css`
- new routes `src/app/(authenticated)/timesheets/page.tsx`,
  `src/app/(authenticated)/manage/page.tsx`, `src/app/(authenticated)/more/page.tsx`
  (shells only — Wave 2 fills their content)

Do:

1. Desktop: persistent left sidebar — Calendar, Timesheets, then a visually
   labeled **Management** group of Managed files and Members, with signed-in
   identity and Sign out at the bottom. Management navigation is always visible;
   it is not a role gate, and it never competes with the daily primary action.
2. Mobile: four-item bottom navigation with ≥44 px targets — Calendar,
   Timesheets, Manage, More. `Manage` opens Managed files and offers Members as
   a sibling; `More` owns account details and Sign out. **No Help or Settings
   destination is introduced.** Page titles and module names match desktop.
3. Publish the slot contract Wave 2 renders into: page header, content region,
   optional sticky footer with safe-area padding. Document it in the file header
   so screen agents do not each invent a page frame.
4. Landmarks, skip link, current-page marking, keyboard order, and focus
   management on navigation.

Proof: both shells expose the same information architecture; keyboard-complete
navigation; no horizontal overflow at 320 / 390 / 768 / 1024 / 1440.

### F5 — SyncStatus, ErrorNotice, and the reusable state gallery

Read: spec §5.4, §8.2, §8.3, §9; mockup `login-states-photo-responsive.html`
(state gallery and error-disclosure sections).

Owns:

- new `src/components/sync-status/*`
- `src/components/api-error-notice.tsx` (rewrite)
- `src/components/loading-ghosts.tsx`, `src/components/ghost-canvas.tsx`
- `src/app/styles/states.css`
- their colocated tests

Do:

1. Implement the eight-state vocabulary **exactly as worded in spec §5.4** —
   `Synced`, `Saved locally`, `Syncing`, `Offline`, `Needs attention`,
   `Remote changes detected`, `Local storage unavailable`, and
   `Saved to Google Sheets · local cache unavailable`. One vocabulary, one
   component; a screen must not phrase its own.
2. Announcements use a **polite live region and never steal focus**.
3. `ErrorNotice` owns recovery actions (Retry, Re-authenticate, Resume, Reload)
   and an optional collapsed `Technical details`. Debug disclosure is gated on
   the existing server-side `APP_DEBUG_ERRORS=1` and may render **only** the
   `GoogleErrorDiagnostic` envelope: `name`, `message`, numeric-or-null
   `status`, `providerMessage`, `providerStatus`, `providerReason`. No unknown
   fields, no bodies, no headers, no URLs with query strings, no stack traces.
   Diagnostics are never persisted to IndexedDB; debug UI is absent when the
   flag is off.
4. Ship all fourteen reusable states from spec §8.2 as composable pieces. Each
   answers: what happened, whether the data is safe, what to do next.
   Page-level failures get page-level recovery; **one broken file stays a
   card/row error and never fails the whole dashboard**.
5. Skeletons reserve final layout dimensions and stop animating under reduced
   motion.

Proof: negative redaction tests covering labeled, unlabeled, URL-encoded, and
base64-shaped representative secrets — none reach the response or the UI. Debug
surfaces absent with the flag off.

### F6 — WizardShell

Read: spec §7.3; mockup `management-wizards.html`.

Owns:

- new `src/components/wizard-shell/*`
- `src/app/styles/wizard.css`
- `src/components/setup-progress.tsx`
- their colocated tests

Do: one shell providing an explicit title and purpose, a desktop step rail and a
compact mobile progress indicator, one principal task per step, slots for
field-level and item-level validation beside the source of the problem, a sticky
Back/Continue or Save row, a desktop live summary and a mobile review step, a
review slot before any Drive mutation, a progress/recovery slot after a mutation
begins, and a Resume affordance. The shell owns steps and chrome only —
**feature wizards own their data and validation.**

Proof: keyboard-complete step traversal; the first invalid field receives focus
only after a submitted step fails; errors bound with `aria-describedby`.

---

## Wave 2 — screens, eight agents in parallel

Every Wave 2 task: consumes F1 tokens/primitives, renders inside F2's slots,
reports state through F5, and must not edit `src/app/layout.tsx`,
`src/app/styles/tokens.css`, `primitives.css`, `shell.css`, or `states.css`.

### S1 — Login

Read: spec §2.3, §8.1. Mockup: `login-states-photo-responsive.html`.

Owns: `src/app/login/page.tsx`, `src/app/page.tsx`,
`src/components/sign-in-button.tsx`, `src/app/styles/login.css`.

Do: one primary `Continue with Google`, explaining that the user signs in with a
blended-asia Google Workspace account, that the app operates under that user's
Drive permissions, and that there is no separate password. Desktop is a split
layout — message and action left, the retained image right. Mobile stacks brand,
image, message, Google action, short trust cue.

`public/meme.jpeg` is **retained and never edited**: complete image on both
desktop and mobile, original aspect ratio, `object-fit: contain`, never cropped
to fill, `alt=""` (decorative). Framing, background, radius, and shadow may
change; the image content may not.

Proof: primary action visible without excessive scrolling at 390 × 844; complete
image present on both surfaces; keyboard-complete sign-in.

### S2 — Calendar dashboard (the primary surface)

Read: spec §3.3, §4.1, §4.2, §5.1, §5.2, §9, §11.1–§11.3. Mockups:
`calendar-detail-interaction.html` (option A), `calendar-day-editor.html`,
`dashboard-foundation.html`. Depends on F3 and F4.

Owns: `src/app/(authenticated)/dashboard/{page,dashboard-client}.tsx`,
new `src/components/month-calendar/*`, new `src/components/day-quick-preview/*`,
`src/components/{day-calendar,day-multi-calendar,month-label}.tsx`,
`src/app/styles/calendar.css`.

Do:

1. The month calendar is the dashboard's dominant surface at both desktop and
   390 px. Each date carries orthogonal states: **Recorded / Not recorded**
   (from F4 — never `Complete`), non-working day, Selected, Today, Local
   changes, Needs attention. A persistent legend explains every visible marker.
   Desktop cells may show a compact duration; mobile cells use short labels and
   markers to preserve a usable hit area.
2. `Today` comes from the spreadsheet's IANA timezone (F4), recomputed when the
   file context changes. Missing or invalid timezone: the calendar stays
   navigable, `Today` is disabled, and the reason is reported. Previous/next
   month move only to an **authorized candidate** with that month; otherwise the
   control is disabled.
3. Context selection is exactly the server-authorized `timesheets` from
   dashboard discovery — not every manager-owned file. One candidate opens
   directly; zero shows `No timesheet for this month` plus the existing
   authorized selection paths; multiple require an explicit choice and the app
   **never guesses**; an unconfigured legacy file goes through the existing
   email-to-tab match and tab chooser; a manager opening another member's tab
   does not become the manager's own candidate; a remembered last context is a
   per-account browser convenience and is re-authorized before use.
4. Day interaction is **option A**: desktop popover anchored to the cell, mobile
   bottom sheet with dialog semantics and safe-area padding. The preview is
   **read-only** — it shows date, attendance state, clock in, clock out, break,
   work hours, notes summary, work-block summary, local/remote sync state, and
   last successful Sheet check. Primary action `Open full detail`. Closes with
   its Close action, Escape, or an outside pointer action where that discards
   nothing; focus returns to the originating date. **Opening a preview must not
   mutate IndexedDB or Google Sheets.**
5. Data flow: first open renders `Preparing your calendar` with a stable
   skeleton, validates the normalized month before exposing it, attempts the
   acknowledged cache write, and renders the remote result even if that write
   fails (disclosing `Local storage unavailable`). Subsequent opens are
   cache-first with background revalidation — render immediately, state plainly
   that cached data is shown with the last successful Sheet check, then
   revalidate. Clean dates merge by date; a **dirty date is never replaced** in
   memory. A failed background check leaves the cached calendar usable and moves
   to Offline / Needs attention with the right recovery action.
6. Keyboard: arrow-key date movement, Enter/Space activation, visible focus
   ring, correct selected/today/state announcements, and every date exposed as a
   full readable date even when the cell shows only a day number.

**Handoff from F5 — fix this, it is a live leak.** `dashboard-client.tsx` (your
file) renders the raw diagnostic as
`<pre className="debug-error">{JSON.stringify(state.debug, null, 2)}</pre>`.
That path bypasses sanitization entirely and prints whatever the server sent.
**It is the only unsanitized debug render left in the app.** Replace it with
`<ErrorNotice … diagnostic={state.debug} />`, which applies F5's allowlist and
redaction. Do not hand-roll a substitute.

**Handoff from F3:** follow **the cache-first render rule** above — the cached
month no longer carries `role`, so render cached data immediately with
role-gated controls absent and reveal them only when the server response
arrives. Also re-point the hardcoded `timeZone: "UTC"` onto F4's
`spreadsheetTimeZone`, treating `undefined` as `null`.

Proof: Recorded/Not-recorded tests across all six carriers; context tests for
zero, one, multiple, duplicate-month, manager-opened, and legacy candidates,
none of which treat navigation state as authorization; Today tests on both sides
of UTC midnight and with a missing timezone; cache-hit renders without waiting
for the network.

### S3 — Timesheets

Read: spec §3.4, §11.1. Mockup: `dashboard-foundation.html`.

Owns: new `src/app/(authenticated)/timesheets/*` (fills F2's route),
`src/app/(authenticated)/dashboard/{open-by-link,recent-files}.tsx` (moved here),
`src/app/styles/timesheets.css`.

Do: the timesheet list plus **Open by link** and **Recent files** as secondary
utilities. Desktop shows Recent files below the list and Open by link in a
compact utility panel; mobile shows the same sections after the current
timesheets with Open by link collapsed until requested.

Security behavior is unchanged and must be re-proven: a pasted link resolves
**only** against server-authorized dashboard results, its `gid` is discarded so
it cannot address an unmapped tab, and the destination route re-authorizes.
Recent files stay account-scoped browser convenience records and grant nothing.

Proof: link-resolver tests still green; both utilities present on desktop and
mobile.

### S4 — Day editor

Read: spec §6.1, §6.2, §5.3, §9. Mockup: `calendar-day-editor.html`. Depends on
F3 and F4.

Owns: `src/app/(authenticated)/files/[fileId]/attendance/**` (editor,
bulk-apply panel, tab chooser, labels),
`src/components/{day-summary,work-block-form,timeline-editor}.tsx`,
`src/app/styles/attendance.css`.

Do:

1. Desktop: header with Back to calendar, readable date, file/member context,
   previous day, Today, next day, and last Sheet check; first column Day summary
   (status, clock in/out, break, calculated work hours, lunch control, notes);
   second column Add work block and Apply this day to other days; a full-width
   lower section with the visual work-report timeline and editable 30-minute
   slots; a sticky footer with the current sync state and `Save & sync`.
2. Mobile: Back/date/prev/next at top; Day Summary first and collapsible once
   summarized; work blocks as readable stacked cards; the detailed timeline
   scrolls horizontally inside its own labeled region or opens a focused slot
   editor **without shrinking touch targets**; `Add work block` stays next to
   the block list; a safe-area-aware sticky footer carries sync state and
   `Save & sync`. **The full form never goes inside the calendar bottom sheet.**
3. Editing: every valid edit requests the date-scoped draft write first;
   `Saved locally` appears **only after that write resolves successfully**. On
   storage failure the edit stays in memory and the UI says
   `Local storage unavailable — keep this page open or save to Google Sheets` —
   it must not claim durability.
4. `Save & sync`: validate the complete day with the existing rules; send only
   the changed cells through the authorized route; disable duplicate submissions
   without blocking reading or scrolling; on success advance the in-memory
   baseline to the confirmed result, then transactionally update the cache
   baseline and clear only the submitted revision; on failure preserve the draft
   and offer Retry or Re-authenticate. Existing same-cell last-writer-wins
   behavior and source-change disclosure are retained — **no atomic pre-write
   conflict editor is introduced.**
5. Sheet write succeeded but the IndexedDB transaction failed: do **not** repeat
   the remote save, do **not** announce `Synced`. Clear the submitted edit from
   pending state, keep the confirmed remote result as the in-memory baseline,
   show `Saved to Google Sheets · local cache unavailable`, and let
   `Retry local cache` retry only the local transaction.
6. The block editor and timeline keep editing **one shared reducer-driven
   draft**, and the editor and its calendar cell share the same local state so
   the calendar reflects local changes immediately. Lunch and work-hour rules
   are unchanged: `workHours = clockOut − break − clockIn`, column H is never
   written, lunch check reserves 12:00 and 12:30, sets break to `1`, and the
   client keeps `lunchBreak` as explicit user intent.
7. Time and duration values stay legible at 200% zoom with no horizontal page
   overflow; the timeline may scroll inside its own labeled region.

Proof: `Saved locally` only after an acknowledged write; the storage-failure and
save-succeeded-cache-failed paths asserted directly; existing attendance
validation and smallest-cell write tests still green.

**Handoff from F3:** make `attendance-draft.ts`'s `loaded` action accept a
role-free cached view (or have the editor take `role` only from the API
response). That is a two-line change on your side, needs no coordination, and
lets the integrator narrow both `toLegacyStore.readMonth`'s documented cast and
the legacy `LocalStore.readMonth` signature to `CachedMonthView`. Follow **the
cache-first render rule** above: cached data renders at once, role-gated
controls stay absent until the server answers.

**Handoff from F4:** `AttendanceMonthView.spreadsheetTimeZone` is declared
optional only because two fixtures you own — `attendance-editor.test.tsx` and
`bulk-apply-panel.test.tsx` — predate the field and F4 could not edit them. Add
`spreadsheetTimeZone: null` to both so the integrator can drop the `?` and make
the field required. Also re-point `attendance-labels.ts` off its hardcoded
`timeZone: "UTC"` onto the spreadsheet zone, treating `undefined` as `null`.

### S5 — Managed files hub

Read: spec §7.1. Mockup: `management-wizards.html`.

Owns: new `src/app/(authenticated)/manage/*` (fills F2's route; extract the
management half out of the old dashboard client),
`src/components/destination-folder.tsx`, `src/app/styles/manage.css`.

Do: the active folder as visible context, and a scannable list/table with file
name and modified time, attendance month, a Ready / Needs setup / Needs repair /
unavailable status, member count or setup progress, and **one clear next
action** (Open, Resume, Repair). `Create monthly file` is the primary action;
`Import XLSX` is secondary. Search and status filters may reduce the visible
list but **must not change discovery or authorization rules**. A broken file is
a row-level error, never a page-level failure.

Coordination: S2 owns the dashboard client file. Take the management markup as a
new module under `manage/`; if S2's file must lose that markup, the integrator
removes it — do not edit it yourself.

### S6 — Members

Read: spec §7.2. Mockup: `management-wizards.html`.

Owns: `src/app/(authenticated)/members/*`,
`src/app/(authenticated)/files/[fileId]/members/*`,
`src/components/{member-inputs,member-rows,roster-picker}.tsx`,
`src/app/styles/members.css`.

Do: a browser-local, signed-in-account-scoped roster. Desktop is a compact
table/list with search and Add member; mobile uses readable member cards.
`Import from Drive` stays an explicit action that adds nobody until selected.
The roster is a convenience source for wizard fields — it **does not grant Drive
access and is never treated as file membership authority**.

Coordination: S7a/S7b consume `member-inputs`, `member-rows`, and
`roster-picker` **read-only**. Keep their public props stable; announce any prop
change to the integrator before landing it.

### S7a — Create monthly file wizard

Read: spec §7.3. Mockup: `management-wizards.html`. Depends on F6.

Owns: `src/app/(authenticated)/files/new/*`, `src/components/month-input.tsx`,
`src/components/google-picker.tsx`.

Do: port the existing wizard onto `WizardShell`, keeping the approved
**Details → Members → Review → Setup** sequence, review before any Drive
mutation, a progress/recovery surface once mutation begins, and Resume for
retained files after a partial failure. The current file is 713 lines — split it
while porting.

Unchanged: never auto-delete a created Drive file as rollback; persist
per-member setup status before invitations and return IDs so the UI resumes;
invitations stay **serialized, never `Promise.all`**; `ATTENDANCE_NAME_MARKER`
keeps its single definition; Picker revalidation is preserved; the Picker token
stays short-lived, `no-store`, and in component memory only.

### S7b — Import XLSX and legacy setup wizards

Read: spec §7.3. Mockup: `management-wizards.html`. Depends on F6.

Owns: `src/app/(authenticated)/files/import/*`,
`src/app/(authenticated)/files/[fileId]/setup/*`.

Do: port both onto `WizardShell`. Import keeps **XLSX upload → workbook
preflight → output details and sheet-owner mapping → review/save → setup**, and
**preflight must name the sheet and the rule responsible for each failure before
Drive is changed**. Legacy setup keeps its adopt-existing-tabs behavior — it must
**never replay `buildEmployeeSheetPlan`'s `updateSheetProperties` row shrink onto
a populated tab**. `initialize` still refuses to overwrite an existing config
sheet unless the import path passes `replaceExisting: true`. The two files are
680 and 485 lines — split while porting.

---

## Wave 3 — verification

### V1 — Responsive sweep

Screenshot and assert 320 / 375 / 390 / 768 / 1024 / 1440 across login,
calendar, day preview, day editor, timesheets, managed files, members, and all
three wizards, in the states that matter. **No horizontal page overflow at any
width**; a separately labeled timeline may scroll internally. Sticky actions
never cover content or platform safe areas. Report failures to the owning agent;
fix only what you own.

### V2 — Accessibility

Automated landmark/name/role/value checks across every route, plus manual checks
for focus order, screen-reader announcements, 200% zoom, WCAG 2.2 AA contrast on
text and interactive states, and reduced motion. Verify keyboard-complete login,
date selection, preview, edit, save, management lists, and both wizards; ≥44 ×
44 CSS px mobile targets; hover is never the only path to detail or an action;
status messages announce without moving focus.

### V3 — End-to-end and documentation

Update the Playwright specs for the new information architecture and the calendar
entry point; add specs for the calendar → preview → editor → save path on both a
desktop and a mobile viewport. Then update
[`docs/product/attendance.md`](../../product/attendance.md) and the `CLAUDE.md`
Layout/Status sections to match what shipped.

E2E runs against the Dockerfile `test` stage:

```bash
docker build --target test -t attendance-e2e .
docker run --rm -v "$PWD:/app" -v /app/node_modules attendance-e2e npm run test:e2e
```

`resolveTestMode` stays the only gate to the deterministic adapter, and
`/api/e2e/reset` still requires both the flag and `X-E2E-Secret`.

**Handoff from F4:** the deterministic fake in
`src/lib/testing/fake-google-store.ts` supplies no spreadsheet timezone, so
under `E2E_TEST_MODE` every file reports `spreadsheetTimeZone: null` and `Today`
is correctly disabled. Add a `timeZone` to the snapshot it returns before
writing any e2e spec that exercises `Today`. **This is the one file V3 may edit
outside its own area** — do not weaken `resolveTestMode` or any product check to
make a browser test pass. Also re-point `dashboard-client.tsx`'s hardcoded
`timeZone: "UTC"` if S2 has not already.

---

## File ownership map

One row per file cluster; the owner is the only task that may edit it.

| Owner | Files |
| --- | --- |
| F1 | `styles/tokens.css`, `styles/primitives.css`, `app/layout.tsx`, all stylesheet splits, `docs/patterns/ui-redesign-contract.md` |
| F2 | `(authenticated)/layout.tsx`, `components/app-shell/*`, `styles/shell.css`, route shells for `/timesheets` `/manage` `/more` |
| F3 | `lib/dashboard/local-store.ts`, `lib/dashboard/local-records.ts`, `lib/cache/*` |
| F4 | `lib/google/sheets-gateway.ts`, `lib/attendance/service.ts`, `lib/attendance/day-state.ts`, `lib/attendance/zone.ts`, `api/files/[fileId]/attendance/[sheetId]/route.ts` |
| F5 | `components/sync-status/*`, `components/api-error-notice.tsx`, `components/loading-ghosts.tsx`, `components/ghost-canvas.tsx`, `styles/states.css` |
| F6 | `components/wizard-shell/*`, `components/setup-progress.tsx`, `styles/wizard.css` |
| S1 | `app/login/*`, `app/page.tsx`, `components/sign-in-button.tsx`, `styles/login.css` |
| S2 | `(authenticated)/dashboard/{page,dashboard-client}.tsx`, `components/month-calendar/*`, `components/day-quick-preview/*`, `components/day-*calendar.tsx`, `components/month-label.tsx`, `styles/calendar.css` |
| S3 | `(authenticated)/timesheets/*`, `open-by-link.tsx`, `recent-files.tsx`, `styles/timesheets.css` |
| S4 | `(authenticated)/files/[fileId]/attendance/**`, `components/{day-summary,work-block-form,timeline-editor}.tsx`, `styles/attendance.css` |
| S5 | `(authenticated)/manage/*`, `components/destination-folder.tsx`, `styles/manage.css` |
| S6 | `(authenticated)/members/*`, `(authenticated)/files/[fileId]/members/*`, `components/{member-inputs,member-rows,roster-picker}.tsx`, `styles/members.css` |
| S7a | `(authenticated)/files/new/*`, `components/month-input.tsx`, `components/google-picker.tsx` |
| S7b | `(authenticated)/files/import/*`, `(authenticated)/files/[fileId]/setup/*` |

Unowned by any screen task and therefore frozen after their wave: `src/auth*.ts`,
`src/lib/auth/*`, `src/lib/access/policy.ts`, `src/lib/google/*` (except F4's
gateway change), `src/lib/workbook/*`, `src/lib/files/*`. A screen task needing
a change there stops and reports.

## Risks And Recovery

- **F1 is a single point of serialization.** Keep it mechanical: re-skin plus
  file split, no markup or behavior change, so it lands fast and the eight-agent
  wave is not blocked on design debate. Recovery: if F1 slips, F3 and F4 still
  progress — they touch no CSS.
- **A screen agent edits a file it does not own.** Detected at merge as a
  conflict. Recovery: the integrator reverts the foreign hunk and asks the
  owner to reapply it. This is why the ownership map is normative.
- **Shared member components drift** between S6 and the wizard tasks. Mitigation:
  S6 owns them; S7a/S7b consume read-only and negotiate prop changes through the
  integrator.
- **The cache contract change ripples** into screens mid-flight. Mitigation: F3
  ships an adapter that keeps current call sites compiling, so S2/S4 adopt the
  new API on their own schedule rather than being blocked.
- **A stale cache can look authoritative.** Mitigated in-product by explicit
  last-checked state plus automatic background revalidation (spec §12).
- **Month caches grow across many files.** Deliberately not auto-deleted — no
  retention policy is approved. Storage pressure surfaces as an acknowledged
  write failure rather than silent loss.
- **Shared-machine profiles retain local attendance records** by current product
  decision. The UI must not imply that Sign out clears them.
- Rollback: every task is a separate branch. Revert a branch to drop one screen
  without unwinding the rest; F1 is the only revert that forces a rebase of
  everything after it.

## Progress

- [x] F1 design foundation, CSS split, token contract — `redesign/f1-design-foundation` (`3fa82d1`), verify EXIT=0, e2e 29/29
- [x] F3 AttendanceCache — `redesign/f3-attendance-cache` (`dddb177`), verify EXIT=0, 790 tests
- [x] F4 spreadsheet timezone and day-state rule — `redesign/f4-timezone-day-state` (`a32146d`), verify EXIT=0, 758 tests
- [x] F2 AppShell — `redesign/f2-app-shell` (`d116053`), verify EXIT=0, e2e 41 passed
- [x] F5 SyncStatus, ErrorNotice, state gallery — `redesign/f5-sync-status-states` (`f64a27b`), verify EXIT=0, 822 tests
- [x] F6 WizardShell — `redesign/f6-wizard-shell` (`14ff5ee`), verify EXIT=0, e2e 29 passed
- [x] F7 server diagnostic redaction (added mid-flight) — `redesign/f7-diagnostic-redaction` (`7ea2aeb`), verify EXIT=0, 747 tests
- [x] Combine the foundation branches — merged into `redesign/integration`, conflict-free; merged tree verify EXIT=0 (1021 tests) and e2e EXIT=0 (41 specs); browser-verified
- [x] S1 login — responsive retained-photo layout and login states
- [x] S2 calendar dashboard — cache-first month grid and day quick preview
- [x] S3 timesheets — reachable-file list with owner identity
- [x] S4 day editor — Calendar return path, sync state, sticky Save & sync
- [x] S5 managed files — destination and file-management hub
- [x] S6 members — roster and file-member surfaces
- [x] S7a create wizard — real four-step WizardShell flow
- [x] S7b import and legacy setup wizards — real preflight/mapping and review gates
- [x] **Always-drawn month grid, IndexedDB month lookup, and manual sync**
  (user-requested, developed in parallel with S2 and merged into it — see the
  note below)
- [ ] V1 responsive sweep
- [ ] V2 accessibility
- [x] V3 e2e and documentation — Calendar → preview → editor → save on desktop/mobile; product and repository docs updated
- [x] Integration gate: `verify` green (1,036 tests plus production build), e2e 51/51 green

## Execution log

- 2026-09-01: Wave 2 screen implementation completed on
  `redesign/screens-completion`. Calendar became the primary dashboard;
  Timesheets, Managed files, Members, the day editor, and all three wizards now
  use the approved Calm-productivity shell and responsive navigation. Import
  now has distinct Upload, Preflight, Details, Review, and Setup states; legacy
  setup has a real Review gate, so neither workflow mutates Drive early.
- 2026-09-01: Browser QA used the installed Chrome profile
  `linh.np@blended-asia.com` against the local Docker app. Desktop and 390 px
  mobile checks covered Calendar, Timesheets, Managed files, Members, Import,
  and the real legacy day editor. No page overflow or console errors were
  observed. The mobile sticky Save row was found one pixel under the bottom-nav
  border and corrected.
- 2026-09-01: Full deterministic Playwright proof is green, 51/51, including
  the Calendar → quick preview → day editor → Save & sync path on desktop and
  mobile, create/import/legacy flows, authorization, shell breakpoints, and
  login artwork. V1 remains open for the exhaustive every-state screenshot
  matrix; V2 remains open for the dedicated screen-reader, 200% zoom, contrast,
  and reduced-motion manual audit.
- 2026-09-01: Final repository gate passed: ESLint, TypeScript, 1,036
  unit/integration tests, and the Next.js production build all completed
  successfully. `git diff --check` also passed; import and legacy wizard files
  remain below the 800-line repository limit.

- 2026-08-31: `redesign/integration` pushed as the shared base — main plus this
  plan and the checked-in mockups. Every task branches from it as
  `redesign/<task-id>-<slug>` and pushes back; the integrator merges in wave
  order.
- 2026-08-31: Wave 0 dispatched — F1 (`redesign/f1-design-foundation`),
  F3 (`redesign/f3-attendance-cache`), F4 (`redesign/f4-timezone-day-state`).
- 2026-08-31: **F4 landed** on `redesign/f4-timezone-day-state` (`a32146d`),
  `verify` `EXIT=0`, 758 tests passing. It publishes:
  - `AttendanceMonthView.spreadsheetTimeZone: string | null` — a validated IANA
    id, or `null` meaning *undeterminable*. Sheets' custom-zone fallback
    (`GMT-07:00`) is rejected as not-IANA. **Treat `undefined` as `null`.**
  - `lib/attendance/zone.ts`: `isIanaTimeZone`, `normalizeSpreadsheetTimeZone`,
    `todayInZone(zone, instant) → "YYYY-MM-DD" | null`.
  - `lib/attendance/day-state.ts`: `dayRecordState(day) → recorded |
    not-recorded`, plus `nonWorkingDaySource` / `isNonWorkingDay`
    (weekend wins over a context-listed date). No `Complete` state.
  - `SpreadsheetSnapshot.timeZone` carries the **raw** Sheets value; validation
    lives in the service so `google/` keeps no dependency on `attendance/`.

  It edited `src/lib/google/types.ts` additively, which the ownership map's
  "except F4's gateway change" carve-out permits. Two handoffs are recorded
  against S4 and V3 below.

- 2026-08-31: **F1 landed** on `redesign/f1-design-foundation`. `verify`
  `EXIT=0` (717 tests) and the full Playwright suite `EXIT=0` (29/29) — that
  e2e run is the rendering proof, so the split is confirmed non-breaking rather
  than assumed. The diff touches only CSS, `src/app/layout.tsx`, and the new
  contract; **no `.tsx` component was edited and no class was renamed**.
  F1 verified the contract mechanically: a script asserted every class and
  token defined in the CSS also appears in `docs/patterns/ui-redesign-contract.md`
  — 0 missing of each. It also fixed a pre-existing bug: the old `shell.css`
  was missing its final closing brace, silently truncating `.debug-error`.

  **Three deliberate removals** in the re-skin, all reversible now and
  expensive later:
  1. the time-rail `.card::before` bar and its `:has()` colouring — that motif
     is exactly what Calm productivity replaces; card state now rides on
     `.card-state`, which carries a shape and a word, not only a colour;
  2. the monospaced numeric face — `--font-numeric` resolves to the UI stack per
     the approved single-stack direction, and tabular alignment comes from
     `font-variant-numeric`, which is what spec §2.2 actually requires;
     `--font-mono` remains for the one correct use, the sanitized debug surface;
  3. `loading.css` and `responsive.css` as files.

  **Two ownership placements** F1 decided because the map did not settle them:
  `.open-file-panel` → `timesheets.css` (S3 owns the controls it frames, even
  though S2's dashboard renders it today); `.card-state*` → `primitives.css`
  (S2 and S5 both render managed-file state and must not each grow a pill).

- 2026-08-31: **Wave 1 dispatched from F1's branch, not from integration.**
  F2 (`redesign/f2-app-shell`), F5 (`redesign/f5-sync-status-states`),
  F6 (`redesign/f6-wizard-shell`) each branch from
  `origin/redesign/f1-design-foundation`. Chaining branches this way preserves
  the dependency order without any merge, so no integration merge is performed
  by an agent; the final assembly is a human decision.

- 2026-08-31: **F3 landed** on `redesign/f3-attendance-cache` (`015e5cd`),
  `verify` `EXIT=0`, 785 tests. Every method returns
  `CacheResult<T>` = `{ok:true,value}` | `{ok:false,reason,message}` with
  `reason ∈ unavailable | blocked | corrupt | quota | migration-refused |
  forbidden-content`. There is no no-op path: `resolveAttendanceCache()` falls
  back to `createUnavailableCache`, whose every method answers `ok:false`.
  Key methods for S2/S4: `readMonth` (a `null` is a **successful** miss),
  `writeMonth` (returns `changedDates` and `conflictedDates` — the latter drives
  `Remote changes detected`), `writeDraft` (**success is the only thing that may
  show `Saved locally`**), `restoreDraft` (byte-for-byte baseline rule;
  a discard must be disclosed), and `commitSave` (one transaction; a failure
  here is the composite `Saved to Google Sheets · local cache unavailable` and
  **must not re-issue the Sheet write**).

  All four spec §5.5 races are proven, and eight deliberate mutations were each
  caught and reverted — including "rejected write returns success", "epoch check
  dropped", and "credential guard disabled". The compatibility adapter keeps
  `LocalStore` signatures unchanged, so six existing call sites compile and
  behave as before without F3 editing any of them.

  Known limits carried forward: the races are proven on an in-repo memory engine
  because the repo has no `fake-indexeddb` and F3 added no dependency, so
  `createIndexedDbEngine` has **no browser-level test — V3 should cover it**.

- 2026-08-31: **Invariant defect found and assigned.** F3 flagged rather than
  silently decided that `AttendanceMonthView.role` was still being persisted.
  Verified: `role` is assigned directly from `authorizeFile` in
  `attendance/service.ts`, so it **is** an authorization result. Spec §5.1 and
  `CLAUDE.md` both forbid one in IndexedDB, and `access/policy.ts:173` already
  says "never a cached role". Pre-existing, but not compliant. F3 is stripping
  it from the persisted record and extending the credential guard to refuse it.
  **Consumers must take `role` from the fresh server response on every load,
  never from cache** — which costs nothing, because every request re-authorizes
  anyway. S2 and S4 must not reintroduce a cached-role read.

- 2026-08-31: **Cached-role defect fixed** (`dddb177`), `verify` `EXIT=0`,
  790 tests, with all four new tests mutation-verified. The persisted type is
  now `CachedMonthView = Omit<AttendanceMonthView, "role">`, so a consumer
  cannot read a role that is not there; `role`, `roles`, `authorized`,
  `permission` and `permissions` joined the credential deny list; and **both
  guards fail closed on read**, so a month cached by the currently shipped build
  is treated as corrupt/miss and refetched role-free rather than trusted. One
  extra fetch on upgrade, which is the right trade.

  No runtime consumer ever read a role off a cached month — every `role` in the
  attendance screens is an ARIA attribute — so what remains is one named,
  documented cast in `toLegacyStore.readMonth`, kept only because narrowing the
  type would fail typecheck in a file S4 owns.

- 2026-08-31: **F6 landed** on `redesign/f6-wizard-shell` (`14ff5ee`),
  `verify` `EXIT=0` (736 tests) and Playwright `29 passed` against the three
  **unported** wizards — the regression guard held, which is the point of not
  porting them in this task. Four deliberate mutations were each caught.

  S7a and S7b import from `@/components/wizard-shell` only, never from a file
  inside it. The pieces that decide their work:
  - `submitAttempt: number` — **increment once per submitted step attempt**.
    Focus moves to the first `aria-invalid` control only when that number
    changes, so focus never moves while someone is still typing. A rerender that
    turns fields invalid without changing it is asserted to leave focus alone.
  - `WizardSummary as="section"` is the mobile review surface and `as="aside"`
    the desktop live summary — **the same renderer**, so review and summary
    cannot drift apart.
  - `WizardField` (render prop) and `WizardItemList`/`WizardItem` keep field-
    and item-level errors **beside the failing control or row**, never collected
    at the top.
  - `SetupProgress` is the post-mutation progress/recovery surface — render it
    as the body of the final `setup` step; the shell needs no extra slot. Its
    description now uses `.wizard-status` rather than F5's `.form-status`,
    because F6 does not own F5's file.

  Accessibility is proven by test, not asserted: keyboard-complete rail
  traversal, `aria-describedby` binding (and *no* `aria-describedby` when there
  is nothing to describe), focus only after a failed submit, live regions that
  do not move focus, and a `.sr-only` word plus a shape on every rail state so
  colour never carries meaning alone. 44 px targets are **inherited from F1's
  primitives, not re-derived** — no bar height or target size is hard-coded.

- 2026-08-31: **F5 landed** on `redesign/f5-sync-status-states` (`f64a27b`),
  `verify` `EXIT=0`, 822 tests (105 new), five deliberate mutations each caught.
  Screen agents import from `@/components/sync-status`, except `ErrorNotice`
  which stays in `@/components/api-error-notice`:
  - `<SyncStatus state cause? detail? lastCheckedLabel? announce?>` is **the only
    place the eight §5.4 words exist**. It renders `role="status"
    aria-live="polite"` and never focuses; `announce={false}` gives the bare
    badge for a calendar cell or list row.
  - `<StateNotice state scope? …recovery handlers>` covers all fourteen §8.2
    states; the words come from the catalog, a screen supplies only handlers.
    `invalid-workbook` and `partial-setup` default to `scope="card"`, so **one
    bad file cannot fail a page**.
  - `<StateSkeleton>` sets `--skeleton-w`/`--skeleton-h` to *final* dimensions,
    shapes `aria-hidden`, label in a polite live region.
  - `<ErrorNotice diagnostic={…}>`: pass the route's `debug` field straight in —
    **the presence of the envelope is the flag**, there is no client-side switch.
  Nothing touches storage, asserted against `Storage.setItem` and
  `indexedDB.open` spies.

- 2026-08-31: **Security defect found in frozen code; F7 opened.** F5 reported,
  and I verified by reading `src/lib/google/errors.ts`, that
  `sanitizeDiagnosticText` leaks two shapes into the **HTTP response** when
  `APP_DEBUG_ERRORS=1`:
  1. the `access_token|refresh_token|client_secret` rule requires a literal `:`
     or `=`, so a percent-encoded `%3D` form passes, and `redactExactSecrets`
     compares raw values so an encoded copy of a known secret also survives;
  2. the `Authorization` rule's `[^\s;,]+` stops at the space, so
     `Authorization: Basic <base64>` loses only the word `Basic` and keeps the
     credential.

  Spec §11.3 requires these not reach the *response*, not merely that the
  browser hides them. F5 closed both in the UI, and its mutation run proved
  empirically that the secret really is in the envelope with only the browser
  gate stopping it. Dispatched **F7** (`redesign/f7-diagnostic-redaction`,
  owning `src/lib/google/errors.ts` and its test only) to fix the server side.

- 2026-08-31: **F2 landed** on `redesign/f2-app-shell` (`d116053`), `verify`
  `EXIT=0` (753 tests) and Playwright `EXIT=0` (41 passed: 29 pre-existing plus
  12 new). Four deliberate mutations produced 9 failing assertions, then were
  reverted. **Wave 1 is complete.**

  The slot contract every Wave 2 screen renders into is
  `src/components/app-shell/page-shell.tsx`:
  `<PageShell eyebrow? title titleId? lede? status? actions? contentClassName?
  footer?>`. **It renders the page's only `<main>` and only `<h1>`** — a screen
  must not nest another, and sections inside `children` start at `<h2>`. Unused
  slots are omitted from the DOM. The `footer` slot is for Save/Back/Continue
  rows and is already lifted clear of the mobile bottom bar and the home
  indicator. `AppShell` exports `MAIN_CONTENT_ID`.

  Proven rather than asserted: one `<nav aria-label="Main">` with the other
  shell's entries removed from both the a11y tree and the tab order, so exactly
  one shell is navigable; no horizontal overflow at all five widths, measured on
  `body.scrollWidth` because `html` would lie (it is `overflow-x: hidden`);
  ≥44 × 44 px boxes on all four mobile targets; skip link first in the tab
  order; `aria-current="page"` maintained across navigation.

  Two judgement calls worth keeping: **the mockup shows Help and Settings
  destinations and the spec forbids them, so the spec won**, and the mockup's
  "Today" became "Calendar". `/more` was implemented fully rather than stubbed —
  no Wave 2 task owns it and it is shell chrome by definition.

  Token behaviour screens must respect: `--app-bar-height` is re-declared as
  `0rem` on `main` at `min-width: 64rem`, because the sticky brand bar exists
  only on the compact shell; `.app-main .sticky-actions` is lifted by
  `--bottom-nav-height + --safe-bottom` there. **Read the tokens; never
  hard-code a bar height.**

- 2026-08-31: **Contract document refreshed** (`3fa82d1` on
  `redesign/f1-design-foundation`), `verify` `EXIT=0`. All three Wave 1
  inventories were applied in **one pass by the file's owner** rather than by
  three agents editing it in turn. F1 verified mechanically: the 173 already
  documented class names intersected with the 79 newly reported ones is empty —
  no collisions — and all 79 landed.

  It also added a **Component entry points** section ahead of the class lists,
  which is the part that actually prevents reinvention: the `PageShell` slot
  contract, the sync/state import rules (with `ErrorNotice` living in
  `api-error-notice`, and `diagnostic` as the way to pass a route's `debug`),
  and the wizard's import-from-the-index-only rule — each framed as "these are
  the internals of X, consume the component". Plus a note that because
  `SyncStatus` owns the eight sync words, **a ninth phrasing is a regression,
  not a wording preference.**

  Three naming hazards are now documented for Wave 2: `.page-*` spans four
  owners (F1's `.page-lede`, F5's `.page-error`, S1's `.page-centered`, F2's six
  slots) and is the most likely thing to misattribute; `.state-*` splits between
  F1's `.state-pill*` and F5's `.state-notice*`/`.state-skeleton`; and
  `.state-skeleton` is a scene built from F1 presets, **not** a `.skeleton`
  variant.

  One genuine duplication was found rather than papered over: F6's
  `.wizard-status-busy`/`-attention` express the same two states as F1's
  `.state-pill-busy`/`-attention`. Both are live and neither is wrong, so it is
  documented with agents steered to `.state-pill` outside a wizard. Converging
  them is an F6 change and a candidate for a later simplification pass — not
  worth an agent mid-flight.

- 2026-08-31: **F7 landed** on `redesign/f7-diagnostic-redaction` (`7ea2aeb`),
  `verify` `EXIT=0`, 747 tests. `sanitizeDiagnosticText` is now a five-stage
  pipeline: percent-decode **per escape run** inside try/catch (so a literal
  `100%` can neither throw nor smuggle anything past the rules); exact known
  secrets matched in raw **and** `encodeURIComponent` form; URL query strings
  collapsed; labeled credentials consumed **whole** to the next `;`/`,`/newline
  across every scheme and in underscore *or* hyphen spelling; then opaque
  shapes — `ya29.`, `1//`, `GOCSPX-`, `AIza`, JWTs, and any ≥32-char
  base64/base64url/hex run. A field left with fewer than three readable letters
  returns `null`, which is spec §8.3's "omit it rather than returning it".

  The module had **no test file at all** before this. The new one fails
  **17 of 28** against the pre-fix implementation — genuine assertion failures,
  not import errors — and passes 30 after. The mutation table is trustworthy for
  a specific reason: two mutations (the narrow header rule, the query-string
  rule) **initially survived** because the opaque-run rule masked them, so the
  tests were strengthened with credentials short enough that only the rule under
  test can catch them, re-proved RED, and only then re-mutated.

  The pre-existing `api/dashboard/route.test.ts` assertion on the exact debug
  envelope still passes byte-for-byte: F7 kept the label-plus-separator capture
  precisely so that contract, in a file it does not own, did not move.

  **Judgement call to revisit if debugging suffers:** a Drive/Sheets file id is
  33 or 44 characters of the same base64url alphabet as a secret, so no
  threshold separates them and ids are now redacted —
  `File not found: [REDACTED]`. The reasoning is that the gate must be able to
  *prove* a value safe, and F5's browser gate would strip a preserved id anyway.
  Restoring ids is a decision for both layers at once, not one branch.

- 2026-08-31: **All seven foundation branches merged** into
  `redesign/integration` on the owner's instruction, in the order f1 → f2 → f5
  → f6 → f3 → f4 → f7. **Every merge was conflict-free.** `main` was already an
  ancestor, so merging it was a no-op.

  The merged tree — which is the first time any of this ran together — is green:
  `verify` `EXIT=0` with **1021 tests passed / 13 skipped** and a clean
  production build, then `test:e2e` `EXIT=0` with **41 Playwright specs passed**.
  Individually-green branches can still break in combination, so this run is the
  proof that matters.

- 2026-08-31: **CI added** at `.github/workflows/ci.yml` — three jobs on push to
  `main`/`redesign/**` and on every pull request: `verify` (lint, typecheck,
  vitest, `next build`), `e2e` (Playwright against the `test` stage), and
  `image` (the production `runner` target, then boot it and `GET /api/health`).
  It runs inside the repository's own Docker stages so CI executes what a
  developer executes, and no step is piped into `grep`/`tail`. A Wave 2 agent
  whose branch is red here has not finished.

### Browser verification of the merged tree

Driven manually against a real Chrome at `127.0.0.1:3100`, with the app in
`E2E_TEST_MODE` behind the deterministic Google adapter (no real Drive call has
ever been made from this repository — see `CLAUDE.md` Status).

Confirmed by looking, not by inference:

- **Login** renders in the Calm productivity palette, and `public/meme.jpeg` is
  present, complete, and uncropped — spec §2.3's requirement that the image is
  retained rather than restyled away.
- **Desktop sidebar** (≥64rem) shows Calendar, Timesheets, a labelled
  **MANAGEMENT** group with Managed files and Members, and the account block
  with Sign out at the foot.
- **Mobile bottom navigation** shows exactly Calendar, Timesheets, Manage, More,
  with the current item marked; the desktop-only entries are absent from the
  DOM's measurable box (width and height 0), not merely hidden by colour.
- **New routes** `/timesheets`, `/manage`, `/more` resolve and carry
  current-page marking. Their placeholders say plainly that the page is still
  being built — honest, and replaced by Wave 2.
- **Route-to-nav mapping** is right where it is least obvious: `/files/new`
  highlights *Managed files*.
- **Accessibility structure** in the a11y tree: a skip link as the first node, a
  `banner`, one `navigation "Main"`, one `main`, one `h1` with `h2` section
  headings beneath it, and a live region present.
- **Zero console errors or warnings** on the dashboard.
- No horizontal overflow at any width reachable through the tool.

Two honest limits on this manual pass:

1. The browser tooling clamps the viewport at 500 px, so **320 and 390 could not
   be measured by hand**. All five widths (320/390/768/1024/1440) *are* asserted
   in F2's `tests/e2e/app-shell.spec.ts`, which passed in the merged e2e run.
2. Switching from the manager to the employee session mid-browser failed:
   Auth.js reissues its session cookie as **httpOnly**, which JavaScript can
   then neither overwrite nor delete. So **the employee attendance edit/save
   flow was not exercised by hand** — it is covered by the merged Playwright
   run, including `a failed save keeps the edits and retries in place`.

What the browser cannot show yet is the redesign's *content*: the screens still
render their pre-redesign markup inside the new shell and palette, because
Wave 2 has not run. The calendar dashboard, day preview, day editor, timesheets,
managed-files hub, members, and the ported wizards are all still ahead.

### What landed ahead of S2 (binding on S2)

The user asked for the calendar's data flow and a manual sync before S2 was
dispatched, so parts of S2's data work already exist. S2 **absorbs** these; it
does not rebuild them, and it does not add a second way to do any of it.

- `src/lib/cache/calendar-state.ts` — the quick-info projection: which month the
  calendar is on, and one `CalendarDayState` per date (`record`, `nonWorking`,
  `workHours`, `statusCode`). It delegates to F4's `dayRecordState` and
  `nonWorkingDaySource` rather than re-deciding either, and it carries **no**
  `role`; the guard refuses a record that does.
- `src/lib/cache/calendar-cache.ts` — acknowledged storage for a snapshot per
  (account, file, sheet, month) plus one pointer per account, written in one
  transaction so the pointer can never name a month whose snapshot failed.
  `engine.ts` gained `CALENDAR_STORE` and `DB_VERSION` rose 3 → 4.
- `src/lib/sync/calendar-sync.ts` — **the one load path**. Discovery, month
  resolution, the sheet read, and the cache write, dependency-injected. It never
  guesses between candidates, never addresses a file discovery did not list, and
  never reports a failure as an empty state. S2's month navigation should call
  this rather than growing its own fetch.
- `src/lib/sync/shared-fetch.ts` — in-flight coalescing for `/api/dashboard`.
  Measured: 84 → 29 dashboard calls across the same 49 e2e specs. It shares only
  while a request is in flight, so it can never serve a stale answer.
- `src/lib/attendance/calendar-grid.ts` — `buildMonthGrid`, which produces the
  month's complete weeks from the month string alone, with real neighbouring
  dates padding the first and last rows. **The grid is never data-dependent**:
  no timesheet, no month, and no Google at all still draw an ordinary calendar,
  and attendance is an overlay on top. S2 must keep that property; replacing it
  with a grid built from `snapshot.days` reintroduces the blank panel.
- `src/components/month-calendar/month-calendar.tsx` — S2's grid, rebuilt on
  `buildMonthGrid`. `days` is an overlay: a date with a sheet row is a button
  and opens the preview, a date without one is an inert cell reading `No
  timesheet data`, and arrow keys walk only the dates that have data.
- `src/app/(authenticated)/dashboard/dashboard-client.tsx` — the four early
  returns that each *replaced* the calendar (no candidate, choose a timesheet,
  choose a tab, first load) are now `CalendarStateNotices` rendered underneath a
  grid that is always drawn. It also gained the `Sync sheet` toolbar action and
  a cold-open read through the calendar pointer.

  Two rule changes to S2's brief, both consequences of the grid no longer
  needing data. **Rule 2:** previous/next are *not* disabled when no candidate
  covers the target month — they step one month at a time, and the jump to the
  nearest month that has a timesheet moved onto the empty-month notice, where it
  is an explicit action rather than a hidden arrow behaviour. **Rule 5:** the
  first-load skeleton no longer stands in for the calendar; the grid is drawn
  immediately and `Preparing your calendar…` sits under it.

  A locator caution for later work: because the grid renders before its data, a
  test that clicks a cell by date alone will hit the inert `No timesheet data`
  cell. Name the record state too.
- `src/lib/cache/calendar-pointer.ts` — one record per account naming the file,
  tab, and month last shown. The month data itself stays in `attendance-cache`;
  this is only its address, and it is what lets a cold or offline open find a
  cached month before discovery answers. **Do not add a second month store.**
- `src/components/settings/sync-settings.tsx` on `/more` — `Sync now`. It is a
  *section*, not a navigation destination: spec §3.2's shell is unchanged.

Server-side, `file-discovery` now returns `unreadable: UnreadableFile[]` and
`/api/dashboard` forwards it. This closes a documented silent failure — a Sheets
outage used to make every candidate vanish, so "the API is down" and "nothing is
shared with you" were the same empty list.

### The cache-first render rule (binding on S2 and S4)

A cached month carries everything needed to draw the calendar and the day data,
including F4's `spreadsheetTimeZone` (a sheet property, not an authorization
result, so it stays cached). A role gates only manager-only affordances.

**Render the cached data immediately with role-gated controls absent, then
reveal them when the network response arrives with the real role.** Never draw
them optimistically from a cached role and retract them, and do not invent a
cached "was I a manager last time" hint — that is the same invariant violation
wearing a different name.

### Watch at integration

- The base `button` rule now carries `min-height: var(--touch-target)` (44 px)
  for WCAG 2.2, which makes every button taller than before. `--app-bar-height`
  rose to `3.75rem` to match, and the day editor's sticky header offsets from
  that token. **Any screen that hard-codes a bar height instead of reading the
  token will drift.**

### Operational notes for every agent

Two things a fresh worktree does not inherit, both discovered the hard way:

- **`.env` is gitignored**, and `docker-compose.yaml` declares `env_file: .env`.
  A new worktree has none, so every docker command fails until
  `cp .env.example .env` runs. Do it as part of branch setup.
- **`node_modules` is a named Compose volume keyed by project name**, which
  defaults to the directory name. Each worktree therefore gets its own empty
  volume, populated from the image on first use — the first
  `docker compose run` in a worktree is slow. That is expected, not a fault.

## Decisions

- 2026-08-31: F1 splits the six shared stylesheets into one exclusively-owned
  file per surface before any screen work starts. Without this the eight Wave 2
  agents collide on `attendance.css`, `manage.css`, and `shell.css`, and the
  parallelism the plan is built for does not exist.
- 2026-08-31: `src/app/layout.tsx` is frozen after F1. It is the one file every
  stylesheet touches, so a single owner registers all of them up front.
- 2026-08-31: F3 ships a compatibility adapter rather than rewriting call sites
  it does not own, so the cache contract can change without blocking screens.
- 2026-08-31: F3 and F4 start in Wave 0 alongside F1 because they touch no CSS
  and no shell — they are the longest pure-logic tasks and should not wait.

## Validation

- Focused proof: each task's colocated tests, listed under its own Proof line.
- Integration or end-to-end proof: Playwright specs for the calendar → preview →
  editor → save path at desktop and mobile viewports (V3); the responsive and
  accessibility sweeps (V1, V2).
- Repository-required checks:

  ```bash
  docker compose run --rm app npm run verify ; echo "EXIT=$?"
  docker build --target test -t attendance-e2e .
  docker run --rm -v "$PWD:/app" -v /app/node_modules attendance-e2e npm run test:e2e ; echo "EXIT=$?"
  ```

- Existing behavior that must stay green (spec §11.4): attendance validation,
  workbook mapping, role authorization, Google Picker revalidation,
  partial-setup recovery, and smallest-cell write behavior.
- Optional proof against the real workbook:

  ```bash
  docker compose run --rm --env REFERENCE_XLSX_PATH=/app/202607勤怠管理表.xlsx \
    app npm test -- tests/reference-workbook.test.ts
  ```

## Result

Screen implementation and automated integration proof are complete. This plan
stays active until the exhaustive V1 responsive-state and V2 manual
accessibility audits are complete.
