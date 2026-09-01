# Runbook — moving sign-in to Supabase

Everything in this file needs a console login that this repository does not
have. Nothing here can be automated from the codebase, and until step 5 the
application keeps signing people in through Auth.js exactly as before.

The code is already in place and shipped: `AUTH_PROVIDER` decides which button
`/login` shows, and the API accepts **both** an Auth.js cookie and a Supabase
session at the same time. So this is reversible at every step — flipping the
switch back signs nobody out.

Read [`docs/decisions/2026-09-02-supabase-holds-google-credentials.md`](../decisions/2026-09-02-supabase-holds-google-credentials.md)
first. It states what the application takes on by storing a Google refresh
token, which is the point of this whole procedure.

---

## 1. Google Cloud — allow Supabase to receive the callback

In the Google Cloud console, the OAuth client this app already uses:

**APIs & Services → Credentials → OAuth 2.0 Client IDs → (your Web client)**

Add to **Authorized redirect URIs**, alongside the existing entries:

```
https://gsacqghdenrkybbnukgr.supabase.co/auth/v1/callback
```

Do **not** remove `http://localhost:3000/api/auth/callback/google` or the
production Auth.js URI. Both paths must work while accounts move across.

Note the **Client ID** and **Client secret** from this screen — step 2 needs
them, and they are the same pair already in `.env` as `AUTH_GOOGLE_ID` and
`AUTH_GOOGLE_SECRET`.

## 2. Supabase — enable the Google provider

**Authentication → Sign In / Providers → Google**

- Enable it.
- Paste the Client ID and Client secret from step 1.
- Leave "Skip nonce check" off.

The scopes are **not** configured here — the application requests them at
sign-in from the single list in `src/auth.config.ts`, so the two sign-in paths
cannot drift into asking for different Drive access.

## 3. Supabase — apply the schema

**SQL Editor**, paste the contents of
[`supabase/migrations/20260902000001_google_credentials.sql`](../../supabase/migrations/20260902000001_google_credentials.sql)
and run it. It creates:

- `public.profiles` — the login information, mirrored from `auth.users` by a
  trigger, readable by each person only for their own row.
- `public.google_credentials` — the encrypted refresh tokens. RLS is on with
  **no policy** and the grants revoked, so no browser key can reach it.

Then confirm, on the **Table Editor → google_credentials → RLS** panel, that it
reads *RLS enabled, no policies*. If it ever lists a policy, something has
granted browser access to refresh tokens — stop and remove it.

## 4. Fill in the two server-only secrets

In `.env` (and in the deployment's environment — never in the repository):

```
SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API keys → service_role>
GOOGLE_TOKEN_ENCRYPTION_KEY=<generate below>
```

Generate the encryption key:

```bash
docker compose run --rm app node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Two things about these values:

- The service role key **bypasses Row Level Security entirely**. It is the only
  key that can reach `google_credentials`, and it must never appear in a
  `NEXT_PUBLIC_` variable, in browser code, or in a commit.
- The encryption key is deliberately not stored in Supabase. A copy of the
  database is useless without it. **Rotating it invalidates every stored
  connection** and everyone signs in again — there is no re-encryption path.

## 5. Flip the switch

```
AUTH_PROVIDER=supabase
```

Restart, open `/login`, and sign in. Expect Google's consent screen every time —
`prompt=consent` is deliberate, because without it Google stops returning a
refresh token for an account that has already granted access, and the callback
would have nothing to store.

## 6. Verify, in this order

1. **`profiles` has a row for you**, with your email and `last_sign_in_at` set.
   If not, the trigger from step 3 did not run.
2. **`google_credentials` has a row for your user id**, and `refresh_token`
   starts with `v1.` and contains nothing resembling a Google token. A value
   starting `1//` means encryption was bypassed — stop and investigate.
3. **The dashboard loads a real month.** This is the real proof: it means the
   server decrypted the stored token, exchanged it with Google, and called
   Sheets on your authority.
4. **Wait out the hour.** An access token lives about an hour. Come back to the
   dashboard afterwards and load a month again. This is the step that actually
   tests the refresh loop — everything before it would also pass with a token
   that never renews, which is exactly the failure this design exists to avoid.

## If sign-in bounces back to `/login`

The callback names its reason in the URL, and `/login` renders it:

| `?error=` | What happened | Who fixes it |
|---|---|---|
| `access_denied` | Consent was declined | The person, by retrying |
| `no-code` | Google returned no authorization code | Retry; if persistent, check step 1 |
| `exchange-failed` | The code was already spent or expired | Retry — do not reuse a callback URL |
| `no-refresh-token` | Google issued no refresh token | Step 2; confirm the consent screen appeared |
| `credential-store-unavailable` | `SUPABASE_SERVICE_ROLE_KEY` missing | Step 4 |

## Rolling back

Set `AUTH_PROVIDER=authjs` and restart. Anyone already holding a Supabase
session keeps working — the API accepts both — and new sign-ins go through
Auth.js again. Nothing needs to be deleted.

## What is not done here

- **Sign-out does not yet clear `google_credentials`.** `disconnect` exists and
  is tested, but nothing calls it. A person who signs out leaves their encrypted
  refresh token in the table until they sign in again and overwrite it.
- **No account is migrated in bulk.** Each person's credential appears the first
  time they sign in through Supabase, and not before.
- **Live proof has not run**, here or anywhere: no Supabase Google provider
  exists in this environment. Every assertion behind this feature is against
  fakes. Step 6 is the first real evidence.
