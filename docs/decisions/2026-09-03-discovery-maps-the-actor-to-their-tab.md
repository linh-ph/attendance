# Discovery maps the signed-in person to their tab again

**Date:** 2026-09-03
**Status:** accepted
**Amends:** [`2026-09-01-nothing-reads-app-config.md`](2026-09-01-nothing-reads-app-config.md)

## Decision

`discovery` reads `__APP_CONFIG!H1:N` for each file it is already opening, and
preselects the tab whose member row carries the **verified session email**.
Everything else the 2026-09-01 decision removed stays removed: no configuration
read in `access/policy`, none in `attendance/service`, no month or status enum
from the sheet, no per-member tab restriction.

## Context

2026-09-01 removed every configuration read, including the member → tab
mapping, and the calendar has asked "Which tab is yours?" ever since. That was
correct on the evidence available: measured that day, all eight of the owner's
attendance files came back with no member mapping, so the read was doing
nothing but costing a call per file.

What it did not account for is that the picker is asked **once per browser
origin**, and the answer lives in IndexedDB. Moving to production is a new
origin, so everyone was asked again on a surface where they had already
answered on localhost — which read as a regression rather than as a design.

The owner asked for the mapping back on 2026-09-03, after the trade-offs below
were put to them.

## Why this is not the thing the workbook contract forbids

The forbidden fallback is matching a **tab title against a person's name**.
That stays forbidden and is covered by a test that fails if it is reintroduced.
Two colleagues sharing a name is not hypothetical, and guessing there opens the
wrong person's hours.

This maps on **email**, which is the member table's identity column, compared
against the normalized server session — never a client-supplied value. An email
does not collide.

## What keeps the cost down

The 2026-09-01 objection was measured, so it is answered structurally rather
than promised away:

- `getSpreadsheet` already returns the tab list, and discovery already calls it.
  If `__APP_CONFIG` is not among the tabs, **no extra call is made at all**.
- Only `H1:N` is fetched. The settings and status ranges are not read, and
  `ConfigRepository` is not involved — so a file with a broken settings table
  still maps correctly.
- Nothing changed for the managed-folder section, which still opens no
  configuration sheet for any card.

## What keeps it from breaking anything

The mapping is a convenience, so every failure resolves to `null` and the
person picks a tab exactly as they do today:

| Situation | Result |
| --- | --- |
| No `__APP_CONFIG` tab | `null`, and no call is made |
| No member row for this person | `null` |
| Members table malformed (a manager's typo) | `null` — a typo must not take the calendar down |
| `getValues` fails | `null`, and the file is still **listed**, never `unreadable` |
| Row points at a deleted tab | `null` |
| Row points at the hidden `__APP_CONFIG` sheet | `null` |

The last one matters most: `tabs` excludes hidden sheets, and the mapping is
re-checked against `tabs`, so a row pointing at the configuration sheet cannot
turn it into an editable attendance grid. `attendance/service` refuses hidden
tabs independently — this is the second lock, not the only one.

The stored `sheetTitle` is treated as a stale label. Identity is the sheet
**ID**, and the title always comes from the file's live tab list, because a tab
can be renamed.

## Consequences

- A person whose file maps them now lands on their own tab with no prompt.
- A server mapping outranks the browser's remembered choice, and the in-calendar
  picker only renders when `sheetId` is `null`. **A mapped person therefore
  cannot switch tabs from the calendar.** This is the pre-2026-09-01 behaviour
  and it is deliberate; cross-tab editing remains a Google Sheets sharing
  concern, not this app's.
- Choosing which **file** to open is unchanged. When several files cover the
  same month the app still refuses to guess — that ambiguity is real and no
  configuration resolves it.
- Files with no member rows behave exactly as they did yesterday. On the eight
  files measured on 2026-09-01 that is all of them, so this change is invisible
  until a manager fills in a roster.

## Proof

Twelve tests in `src/lib/discovery/member-tab-mapping.test.ts`. The two guards
were verified by deliberate mutation rather than by assertion alone:

- trusting the stored row instead of the live tab list fails
  *refuses a mapping onto the hidden configuration sheet* and *drops a mapping
  whose tab no longer exists*;
- adding a tab-title-versus-name fallback fails
  *never matches a tab title against the actor's name*.

Four Playwright specs encoded the removed behaviour and were rewritten; one of
them was passing on a substring match of `Timesheet` against the `Timesheets`
list heading, which hid a missing navigation wait. Full suite: 1,168 unit and
integration tests, 57 Playwright tests.
