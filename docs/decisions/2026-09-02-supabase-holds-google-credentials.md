# Supabase holds identity, and one Google credential

Date: 2026-09-02
Status: accepted
Supersedes: the "no database, no server-side user store" clause of the stack
description in [`CLAUDE.md`](../../CLAUDE.md).

## Context

The owner asked for Google sign-in to run through Supabase and for user login
information to live in a Supabase database.

The obstacle is specific. Every Drive and Sheets call this application makes
runs on the signed-in person's own Google access token, and that token lasts
about an hour. Auth.js keeps it alive today: `authConfig` requests
`access_type: "offline"`, stores Google's refresh token in the session JWT, and
`refreshGoogleToken` exchanges it whenever the access token expires. The
credential never leaves the person's own browser cookie.

Supabase Auth returns `provider_token` and `provider_refresh_token` **once**, at
sign-in, and does not refresh the provider token afterwards — it refreshes its
own session, not Google's. Moving sign-in to Supabase without doing anything
else would therefore break every Drive and Sheets call roughly an hour after
sign-in, which is the whole function of the product.

Keeping it working means the application must hold each person's Google refresh
token and perform the exchange itself.

## Decision

Supabase Auth performs Google sign-in. The application stores each person's
Google refresh token, encrypted, and exchanges it for access tokens as needed.

The owner took this decision on 2026-09-02 with the consequence below stated.

## Consequences

**The application becomes a credential custodian.** This is the real cost, and
it is not reversible by a later patch:

- A Google refresh token does not expire on its own. A row of
  `public.google_credentials` is durable authority to act as that person in
  Drive and Sheets until they revoke the grant.
- The database is now a high-value target in a way it was not before. Previously
  a total compromise of application storage yielded stale attendance rows;
  now it yields, with the application key, standing access to every member's
  Drive.

What is in place to hold that down:

- **Encrypted at rest with a key the database does not hold.** AES-256-GCM,
  `src/lib/supabase/token-crypto.ts`. Reading the table is not sufficient.
- **Authenticated encryption.** A tampered ciphertext is refused rather than
  decrypted into rubbish that would then be sent to Google.
- **Unreachable by any browser key.** `google_credentials` has RLS enabled with
  no policy and its grants revoked, so `anon` and `authenticated` are denied
  outright. Only the service role reaches it, and only the server holds that.
- **The refresh token never leaves the server module.** `accessTokenFor` returns
  a short-lived access token; nothing exposes the refresh token to a caller.

Still true, and worth keeping true:

- Every Drive and Sheets call still runs on the person's own authority. Google's
  sharing remains the boundary; the application adds none.
- `profiles` holds only what a person can already see about themselves, under
  RLS scoped to `auth.uid()`.

## Alternative not taken

Keeping Auth.js for Google sign-in and using Supabase only for user records
would have delivered "user login information in Supabase" with no credential
stored anywhere. It was offered and declined in favour of a single identity
provider.
