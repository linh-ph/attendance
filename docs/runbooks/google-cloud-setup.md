# Application Runbook: Google Cloud Setup

## Status of this document

Everything below is written as **instructions for a human operator**. None of
these external Google Cloud steps have been performed from this repository, and
no live Google OAuth, Drive, Sheets, or Picker call has been proven here: this
environment has no Google credentials, no Workspace test accounts, and no access
to the Cloud console. Treat every step as unverified until the operator runs it
and records the result.

The application's local checks (`npm run lint`, `npm run typecheck`,
`npm test`, `npm run build`, the Docker image build, and `/api/health`) do not
require any of this. Every Drive- and Sheets-backed feature does.

## Scope

Preparing one Google Cloud project so the attendance application can:

- sign a Workspace user in with Google OAuth;
- call Google Sheets and Google Drive with that user's own authority;
- discover attendance files through Drive metadata;
- let a manager pick a My Drive folder or a legacy file through Google Picker.

## Prerequisites

- A Google Cloud project you can administer, in the same organization as the
  Workspace accounts that will use the application.
- Permission to enable APIs, edit the OAuth consent screen, and create OAuth
  clients and API keys in that project.
- Google Workspace accounts to test with. At least one manager account that will
  own attendance files, and at least one employee account in the same
  organization. Employee discovery only lists files whose current owner email
  ends with `@blended-asia.com`, so the manager account must be in that domain.
- A copy of an attendance workbook for the import path, for example
  `202607勤怠管理表.xlsx`.

## 1. Enable APIs

In **APIs & Services → Library**, enable all three for the project:

| API | Used for |
| --- | --- |
| Google Sheets API | Reading and writing spreadsheet values, sheets, and protections |
| Google Drive API | File create, upload/convert, metadata, permissions, folder validation |
| Google Picker API | The browser folder picker and explicit legacy-file selection |

The Picker API is a separate library entry from the Drive API. Enabling Drive
alone leaves the picker non-functional.

## 2. Configure the OAuth consent screen

In **APIs & Services → OAuth consent screen**:

1. Choose the **Internal** user type if the project belongs to the Workspace
   organization that will use the application. Choose **External** only if it
   does not; that path also requires explicit test users during development.
2. Fill in the application name, user support email, and developer contact
   email.
3. Set the publishing status to **Testing** while developing, and add every
   account you intend to sign in with under **Test users**. An account that is
   not listed cannot complete the consent flow while the app is in Testing.

## 3. Declare the scopes

Add exactly these scopes. The application requests all of them in one consent,
and discovery breaks if any is missing:

| Scope | Why the application needs it |
| --- | --- |
| `openid` | User identity |
| `email` | The normalized signed-in email that every authorization decision uses |
| `profile` | Display name |
| `https://www.googleapis.com/auth/spreadsheets` | Reading and writing attendance sheets |
| `https://www.googleapis.com/auth/drive.file` | Create, upload/convert, share, and protect app-created or explicitly picked files, and the Picker-selected folder |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | Automatic discovery of owned and shared attendance files |

### Approval and verification risk

`drive.metadata.readonly` is a **restricted** scope.

- Internal organizational use may qualify for Google's internal-use exception,
  but the Workspace organization can still require an administrator to approve
  or allowlist the OAuth client before users may consent.
- If the project is ever published as External, the restricted scope triggers
  Google's restricted-scope verification, which includes an application review
  and can require a third-party security assessment. Budget time for this before
  planning any non-internal rollout.
- Until approval exists, keep the app in Testing with named test users. That is
  the supported development path and needs no verification.

Reference: <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>

## 4. Create the OAuth client

In **APIs & Services → Credentials → Create credentials → OAuth client ID**,
choose **Web application** and configure:

- **Authorized redirect URI** — exactly
  `http://localhost:3000/api/auth/callback/google`
  for local and Docker Compose runs. Add one entry per deployed origin later,
  using the same `/api/auth/callback/google` path.
- **Authorized JavaScript origin** — `http://localhost:3000`. This is required
  because Google Picker runs in the browser; without it the picker fails to
  load even though the server-side OAuth flow works.

Record the generated **client ID** and **client secret**.

## 5. Create the Picker API key and record the project number

1. In **Credentials → Create credentials → API key**, create a key for the same
   project.
2. Restrict it. Under **Application restrictions** choose **Websites** and add
   the HTTP referrer `http://localhost:3000/*` plus one entry per deployed
   origin. Under **API restrictions** restrict the key to the **Google Picker
   API**. This key is served to the browser, so an unrestricted key is a leak,
   not a secret.
3. Copy the Cloud **project number** (the numeric value on the project's
   dashboard, not the project ID). Google Picker uses it as the app ID.

## 6. Fill `.env`

From the repository root:

```bash
cp .env.example .env
```

Then set:

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | A fresh random secret, for example `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | OAuth client ID from step 4 |
| `AUTH_GOOGLE_SECRET` | OAuth client secret from step 4 |
| `AUTH_URL` | `http://localhost:3000` locally |
| `AUTH_TRUST_HOST` | `true` |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | Referrer-restricted Picker API key from step 5 |
| `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER` | Cloud project number from step 5 |

`.env` is gitignored. Do not commit it and do not paste secrets into
`.env.example`, which documents names only. Only the two `NEXT_PUBLIC_` values
are meant to be browser-visible; the client secret and `AUTH_SECRET` must stay
server-side. Per-user Google access and refresh tokens are never written to
`.env` — they live in the encrypted session cookie.

## 7. Start the application

```bash
docker compose build app
docker compose up --detach app
curl http://localhost:3000/api/health     # expects {"status":"ok"}
```

`/api/health` proves the container is serving. It does **not** prove any Google
configuration is correct — the first sign-in does.

Stop only this project's containers when finished:

```bash
docker compose down
```

## Live smoke checklist

Run this end to end after the steps above, with a real manager account and a
real employee account. Record the observed result of each line; an unrun line is
not a pass.

### Manager: create, share, protect

- [ ] Sign in as the manager. Consent lists identity, Sheets, and both Drive
      scopes, and completes without an "app not verified" block.
- [ ] Select a dashboard folder through Google Picker. It offers folders only,
      and the picked folder's name is shown while its ID stays internal.
- [ ] Create a monthly file with a name containing `勤怠管理表` and two members.
      Confirm in Google Drive that the file is a **direct child** of the picked
      folder and that the manager owns it.
- [ ] Open the file in Google Sheets. Confirm one tab per member plus a hidden
      `__APP_CONFIG` tab, `D3:I3` headers, merged hour headers across `J2:AS2`,
      alternating `0`/`30` minute headers across `J3:AS3`, one row per day of the
      selected month from row 4, and a `=F-G-E` formula in column H.
- [ ] Confirm each employee tab is protected with the owner and the mapped
      employee as permitted editors, and that `__APP_CONFIG` is owner-only.
- [ ] Confirm each employee received a Drive writer permission.

### Employee: discovery and mapped save

- [ ] Sign in as the employee in a separate browser profile. The file appears
      under `My timesheets` and no other manager file does.
- [ ] Open the mapped timesheet, set status, clock in, clock out, and a work
      block, tick `Lunch break · 12:00–13:00`, and add a note.
- [ ] Save, then inspect the sheet. Only the edited cells changed; the 12:00 and
      12:30 slots stayed empty; column G is `1`; column H still holds the
      formula and shows the recalculated value; the note is in column I.
- [ ] Confirm the employee cannot edit another employee's tab directly in Google
      Sheets, and that the application refuses to open it.

### Folder parent verification

- [ ] Import an `.xlsx` workbook, map every sheet to an email, and save. The
      converted Google Sheets file is a direct child of the confirmed
      destination folder, and that folder becomes the active dashboard folder.
- [ ] Move a matching file into a **subfolder** of the active folder. It
      disappears from the manager dashboard, confirming direct-children-only
      listing.
- [ ] Trash the active folder, or move it to a Shared Drive, then reload the
      dashboard. The manager section shows `Folder unavailable` and requires a
      new selection instead of scanning all of Drive.
- [ ] Confirm a matching owned file without app configuration shows as
      `Needs setup` and that the application performs no Drive mutation on it
      until the manager reselects that same file through Google Picker.

### Revoked-token re-consent

- [ ] At <https://myaccount.google.com/permissions>, remove the application's
      access for the signed-in account.
- [ ] Return to an attendance page with unsaved edits and try to save. The
      application reports an authorization failure, keeps the unsaved edits, and
      offers re-authentication rather than silently discarding the form.
- [ ] Re-consent and save again. The save succeeds and writes only the changed
      cells.

## Ownership and cleanup

Every Drive file, permission, and sheet protection created during a smoke run is
owned by the test manager account. Delete those files from that account's Drive
when finished. `docker compose down` stops only this Compose project. Revoking a
test account's OAuth grant does not delete files it already created.

## Unknowns

Do not invent answers to these; ask the operator or the Workspace administrator.

- Whether this Workspace organization requires administrator approval or client
  allowlisting before users may consent to `drive.metadata.readonly`.
- Which Google Cloud project, OAuth client, and API key the team will actually
  use, and who owns their rotation.
- The deployed (non-`localhost`) origins and redirect URIs.
- Which accounts are approved as manager and employee test identities.
