# Deployment: CI, secrets, and CD to Vercel

How a commit gets from `main` to production, what proves it is safe on the way,
and what to do when part of it fails.

Companion runbooks: [`google-cloud-setup.md`](google-cloud-setup.md) for the
OAuth client, [`supabase-auth-setup.md`](supabase-auth-setup.md) for the
Supabase project.

## The shape of it

```
push to main
   |
   +-- CI ............... lint, typecheck, unit tests, build
   |                      Supabase connectivity   <-- new
   |                      Playwright browser proof
   |                      production image + GET /api/health
   |
   +-- CD (only if CI succeeded, only for a push to main)
          1. sync GitHub secrets -> Vercel project environment
          2. deploy the exact commit CI verified
          3. GET /api/health on the live deployment
```

Secrets flow one way, and each hop has a script:

```
your .env  (+ .env.production overlay)
   |  scripts/push-github-secrets.sh
   v
GitHub Actions secrets
   |  scripts/sync-vercel-env.mjs   (runs inside CD)
   v
Vercel project environment
   |  scripts/deploy-vercel.mjs     (runs inside CD, after the sync)
   v
the running deployment
```

The list of variables lives in exactly one place,
[`scripts/deploy-env.manifest`](../../scripts/deploy-env.manifest). Both scripts
and the CD workflow read it. If you add an environment variable, add it there
first — nothing else has its own copy of the list.

## First-time setup

### 1. Write the production overlay

`.env` is a development file. Two of its values are actively wrong in
production, and both fail quietly rather than loudly:

| Variable | Local | Why it must not ship |
| --- | --- | --- |
| `AUTH_URL` | `http://localhost:3000` | Auth.js builds every OAuth redirect from it, and its session cookie is `Secure`. A localhost or plain-http value means nobody can sign in, with no message saying why. |
| `APP_DEBUG_ERRORS` | `1` | Lets API routes return internal error detail to the browser. |

So:

```bash
cp .env.production.example .env.production
$EDITOR .env.production
```

Put in it *only* the keys that differ from `.env`. It is an overlay, not a
second copy, and it is gitignored.

A key written **empty** there means "unset in production" — it does not fall
back to `.env`, it is not pushed as a secret, and any existing secret and Vercel
variable of that name is removed. That is how `APP_DEBUG_ERRORS=` turns the
setting off everywhere rather than merely failing to update it.

`push-github-secrets.sh` refuses to run while either of the two values above
looks like a development value. `--allow-dev-values` overrides the refusal and
should be reserved for deliberately deploying a throwaway preview.

### 2. Push the secrets

```bash
./scripts/push-github-secrets.sh --dry-run   # see the plan first
./scripts/push-github-secrets.sh
```

It prints names, scopes and source files — never a value — and asks before
writing. Values are piped to `gh` on stdin, so they never appear in `ps` output
or your shell history.

Check the result with `gh secret list`.

### 3. Confirm the Vercel side resolves

```bash
node --env-file=.env --env-file=.env.production scripts/sync-vercel-env.mjs --dry-run
VERCEL_DEPLOY_SHA=$(git rev-parse HEAD) node --env-file=.env scripts/deploy-vercel.mjs --dry-run
```

The first lists what would be written to the project. The second resolves the
project and its GitHub link and stops before creating anything.

`--env-file` is Node's own flag; there is no dotenv dependency, and passing the
two files in that order reproduces the same overlay the push script uses.

## The two scopes, and why `VERCEL_TOKEN` stops at GitHub

The manifest's `SCOPE` column is a security boundary, not bookkeeping:

- **`runtime`** — the deployed application reads it. Pushed to GitHub *and*
  synced into the Vercel project.
- **`deploy`** — only the CD workflow reads it. Pushed to GitHub and **never**
  written to the Vercel project. `VERCEL_TOKEN` can redeploy this project and
  read every variable in it; a running web application has no use for that.

Three values are deliberately in neither list and therefore reach neither
GitHub nor Vercel: `DATABASE_PASSWORD`, `SUPABASE_DB_HOST` and
`SUPABASE_PROJECT_REF`. They exist for applying migrations with `psql`. As
`CLAUDE.md` puts it, the application never opens a Postgres connection — it goes
through PostgREST — so shipping a database password to a web host that cannot
use it is pure blast radius.

`E2E_TEST_MODE` is likewise never sent. `resolveTestMode()` throws under
`NODE_ENV=production`, and weakening that to make something pass is out of the
question.

## Why the order inside CD is fixed

**Sync first, deploy second.** Vercel resolves environment variables when a
deployment is *built*, so a value written after a build is not in that build.
Syncing second would give a green pipeline and a production deployment still
running the previous environment — a failure that surfaces days later as
"sign-in is broken", with nothing in any log to explain it.

**Deploy explicitly, by sha.** The Vercel project is linked to this repository,
so a push already triggers a deployment on its own. That deployment starts the
moment the commit lands, in parallel with CI: it builds code nothing has
verified, with whatever environment predates the run. Deploying from CD — after
CI is green, after the sync, naming the exact commit — is the only ordering in
which "what is in production" and "what passed CI" are the same commit with the
same configuration.

A consequence worth knowing: on a push to `main` you may see two deployments,
Vercel's own and this one. The CD one is the authoritative last write.

## The Supabase connectivity job

Everything else in CI proves the code is correct. This job proves the project
it will talk to is actually there and configured — a class of failure that lives
in the Supabase dashboard rather than in the repository, and that a green build
therefore cannot see.

It runs [`scripts/verify-supabase.mjs`](../../scripts/verify-supabase.mjs),
which checks that the project answers, that the Google provider is enabled and
that **Google accepts the handoff**, that the schema is applied, that
`google_credentials` *refuses* the browser publishable key, that the service
role can read and write it, and that the encryption key is the right shape.

Two of those deserve emphasis:

- The `google_credentials` check must **fail to be readable**. A 200 there would
  mean encrypted Google refresh tokens are readable with a key that ships to
  every browser. The script also treats a 404 as inconclusive rather than a
  pass, because PostgREST answers 404 both for a denied table and for one that
  does not exist — counting that as "locked down" would report a project with no
  schema at all as secure.
- The OAuth handoff check does not treat a 302 as success, because Google
  refuses a bad client *by redirecting* to its own error page.

It reads only. Its single write is a probe row against an all-zero user id that
`auth.users` will never issue, and it is removed again.

**On a fork's pull request the job skips**, because GitHub withholds secrets
from fork PRs by design. Anywhere else, missing secrets **fail** the job — a
silent skip would let an unconfigured project sail through to a deploy.

## When something fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| CI `Supabase connectivity` fails with "No Supabase secrets on this repository" | Secrets were never pushed | `./scripts/push-github-secrets.sh` |
| `Google provider enabled` fails | Dashboard step not done | [`supabase-auth-setup.md`](supabase-auth-setup.md) |
| `Google accepts the OAuth handoff` fails with `redirect_uri_mismatch` | The Supabase callback is not an authorized redirect URI | Add `<project>/auth/v1/callback` to the OAuth client |
| CD sync fails with HTTP 403/404 reading the project | The token is scoped to a different account than owns the project | Set the optional `VERCEL_TEAM_ID` secret |
| CD deploy fails "no GitHub link" | The Vercel project lost its Git connection | Reconnect in Vercel → Settings → Git |
| Deploy is `READY` but `/api/health` fails | The build succeeded and the app does not boot | Open the build/function logs at the inspector URL in the job output |
| Sign-in works locally, fails in production | `AUTH_URL` is wrong, or is not an authorized redirect URI on the Google client | Fix `.env.production`, re-push, re-run CD |

Re-running CD without a code change: **Actions → CD → Run workflow**. That
re-syncs the environment and redeploys current `main`, which is what you want
after rotating a secret — rotating changes nothing in the repository but must
reach a new build to take effect.

## Known limitation: preview deployments share the production `AUTH_URL`

The sync writes every runtime variable to both the `production` and `preview`
targets, matching how this project's variables were already configured. For
`AUTH_URL` that is a compromise: a preview deployment will send its OAuth
redirects to the production domain.

It is recorded here rather than silently changed because fixing it properly
means either dropping `AUTH_URL` and relying on `AUTH_TRUST_HOST` for host
detection, or maintaining per-target values — both are behaviour changes to
sign-in, and neither belongs in a pipeline commit. Preview sign-in is not
currently part of any workflow.

## Rotating `GOOGLE_TOKEN_ENCRYPTION_KEY`

Don't, unless you mean it. Per `CLAUDE.md` it encrypts every stored Google
refresh token and the database does not hold it; rotating invalidates every
stored connection and there is no re-encryption path. Everyone signs in again.

If you must: change it in `.env` (or `.env.production`), re-push the secrets,
and run CD manually so a new build picks it up.
