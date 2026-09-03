# Nothing reads `__APP_CONFIG`

Date: 2026-09-01
Status: accepted, **partly amended 2026-09-03**
Amended by: [`2026-09-03-discovery-maps-the-actor-to-their-tab.md`](2026-09-03-discovery-maps-the-actor-to-their-tab.md),
which restores exactly one read — discovery preselecting a tab from an
`H1:N` row matching the session **email**. Every other removal below still
stands.
Supersedes: the `__APP_CONFIG` read contract in
[`2026-08-29-app-is-a-sheets-client.md`](2026-08-29-app-is-a-sheets-client.md),
which demoted the sheet to "optional metadata, still readable".

## Context

The 2026-08-29 decision stopped `__APP_CONFIG` being an authorization gate but
left every read in place: the policy still resolved a member to their tab where
a configuration existed, the attendance service still took the month and the
status enum from it, and discovery still opened it once per candidate file.

Measured on the owner's own account on 2026-09-01: **all eight** attendance
files come back from discovery with `sheetId: null`. Not one carries a member
mapping. Every configuration read was therefore doing one of two things — the
failure branch, or nothing.

It was not free. Pressing `Sync sheet` issued only `/api/dashboard` and wrote
nothing, because the month-load effect starts by refusing a timesheet with no
`sheetId`. Listing a manager folder opened every card's configuration sheet just
to read back a month and a state that Drive `appProperties` already carries.

The owner asked for the configuration sheet to be removed. This decision covers
the reading half; the manager-side writers are deliberately untouched for now.

## Decision

**No code path reads `__APP_CONFIG`.** What it supplied comes from elsewhere:

| Was read from the sheet | Comes from now |
| --- | --- |
| the month | `appProperties.attendanceMonth`, else the file-name marker |
| the status enum | `STATUS_OPTIONS`, which the sheet only mirrored |
| the member → tab mapping | the person picks; the calendar remembers per file |
| a card's setup state | `appProperties.attendanceSetupState`; absent means `needs-setup` |

Consequences:

- `FileRole` is `manager` (current Drive owner) or `open`. The `employee` role
  and the per-member tab restriction are gone: cross-tab access is Google's
  decision, and every member already has edit access to the whole file.
- The **hidden** configuration tab is still refused as a place to record hours,
  for reads and for writes. Without that guard, dropping the mapping would have
  made it an editable attendance grid and a save would overwrite the settings
  table.
- Discovery preselects no tab and never matches a tab title against a name.
- `memberCount` on a managed card is `null`.

## Not decided here

The manager flows — create monthly file, import `.xlsx`, setup, members — still
*write* the sheet, and `src/lib/config/` still exists for them. Whether those
flows keep the sheet, drop it, or go away is a separate decision.

## Consequences

- One Sheets call per managed card and per employee candidate disappears.
- `needs-setup` / `needs-repair` can no longer arise from the attendance path;
  they remain on the setup, import, and member routes, which do write the sheet.
- A file this app never touched now reads as `needs-setup` rather than
  `unknown`, which is what the manager screen needs to offer setup on it.
