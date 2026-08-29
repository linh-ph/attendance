# The app is a convenience client, not an authorization layer

Date: 2026-08-29
Status: accepted
Supersedes: spec §5.2, §5.3, §7.3 and the limitation "Shared Drive folders are
not supported in the first version".

## Context

The product goal, as stated by the owner: each person records their own
attendance; the app exists so people do not have to keep Google Sheets links
themselves and do not have to edit the grid by hand. It is a tool for clocking
in and for creating and sharing the monthly file.

The original design made `__APP_CONFIG` the authorization boundary: a
non-owner could only reach the sheet the protected configuration mapped to
their email.

Measured against the real workbooks on 2026-08-29, that boundary protects
nothing. All eight attendance files return `protectedRanges: []` — there is not
one protected range in any of them, and every member has edit access to the
whole file. Anyone can already open the file in Google Sheets and edit a
colleague's tab in one click. The app's check therefore restricted only the
people who used the app, while leaving the same action available beside it.

It also had a real cost: no existing file can be opened at all until a manager
runs setup, so none of the eight real files were usable.

## Decision

Google's own sharing is the security boundary. The app does not add one.

- Any attendance file the signed-in account can reach through Drive can be
  opened, whether or not it carries `__APP_CONFIG`.
- The person chooses which tab is theirs. A wrong choice is not a security
  event; Google decides what the write is allowed to do.
- Shared Drive files are supported. `ownedByMe` is no longer required, because
  organization-owned files have no owner and the current-owner manager model
  cannot describe them.
- Cross-tab editing is out of scope. It is a Google Sheets sharing concern, and
  the owner has decided not to manage it in this app.
- `__APP_CONFIG` remains readable where it exists, as optional metadata. It is
  no longer a gate.

## Consequences

- Every server call still runs on the signed-in user's own Google credentials,
  so nobody can do anything Google would not already let them do.
- Per-tab isolation, if it is ever wanted, comes from protected ranges on the
  file — not from this app's configuration sheet.
- The employee/manager split becomes a UI distinction, not a permission one.
