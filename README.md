# Google Sheets Attendance

An English-language attendance application backed by Google Sheets. Google
Sheets stays the source of truth; the application has no database.

- Product behavior: [`docs/product/attendance.md`](docs/product/attendance.md)
- Google Cloud prerequisites: [`docs/runbooks/google-cloud-setup.md`](docs/runbooks/google-cloud-setup.md)
- Full design: [`docs/specs/2026-08-28-google-sheets-attendance-design.md`](docs/specs/2026-08-28-google-sheets-attendance-design.md)

## Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose`). Everything below
  runs inside the image, so a local Node installation is not required.
- A Google Cloud project and OAuth client, prepared by an operator following
  [`docs/runbooks/google-cloud-setup.md`](docs/runbooks/google-cloud-setup.md).
  The application starts and serves `/api/health` without them, but every Google
  Drive and Google Sheets feature needs them.

The image pins Node `24.19.0`. `package.json` requires `node >= 24.19.0` if you
choose to run the toolchain outside Docker.

## Configure

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

`.env` holds application-level Google credentials only:

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | Encrypts the Auth.js JWT session |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_URL` | Application base URL, `http://localhost:3000` locally |
| `AUTH_TRUST_HOST` | `true` for local and container runs |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | Browser-visible Picker API key |
| `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER` | Browser-visible Picker app ID |

`.env` is gitignored and never committed; `.env.example` documents the variable
names without values. Only the two `NEXT_PUBLIC_` values are intended to reach
browser JavaScript. The OAuth client secret, the session secret, and per-user
Google access and refresh tokens never leave the server, and per-user tokens are
never written to `.env` — they live in the encrypted session cookie.

## Build, test, run

```bash
# Run the checks. The working tree is bind-mounted, so no rebuild is needed
# between runs.
docker compose run --rm app npm run lint
docker compose run --rm app npm run typecheck
docker compose run --rm app npm test
docker compose run --rm app npm run verify   # lint + typecheck + test + build

# Start the development server
docker compose up --build app

# Readiness
curl http://localhost:3000/api/health          # {"status":"ok"}

# Stop only this Compose project
docker compose down
```

Compose defines a single service. `app` bind-mounts the working tree and keeps
`/app/node_modules` in a named volume, so focused runs pick up current files
without rebuilding the image. `docker compose up app` starts the Next.js
development server on port 3000; `docker compose run --rm app <command>`
overrides that to run a check instead.

The Playwright suite is the one thing this service cannot run: its `deps` target
carries no Chromium. Build the Dockerfile's `test` stage for that.

```bash
docker build --target test -t attendance-e2e .
docker run --rm -v "$PWD:/app" -v /app/node_modules \
  attendance-e2e npm run test:e2e
```

The production image is built from the `runner` stage and gets its own compose
file.

## Optional: prove the supplied reference workbook

`tests/reference-workbook.test.ts` checks the real `202607勤怠管理表.xlsx`
against the workbook contract. The workbook is not committed, so the suite runs
only when `REFERENCE_XLSX_PATH` points at a readable copy and is skipped
otherwise — a plain `npm test` reports it as skipped, never as a pass.

When the workbook sits in the repository root it is already inside the
container's bind mount:

```bash
docker compose run --rm \
  --env REFERENCE_XLSX_PATH=/app/202607勤怠管理表.xlsx \
  app npm test -- tests/reference-workbook.test.ts
```

From anywhere else, mount it read-only rather than copying it into the
repository:

```bash
docker compose run --rm \
  -v "/absolute/path/to/202607勤怠管理表.xlsx:/ref.xlsx:ro" \
  --env REFERENCE_XLSX_PATH=/ref.xlsx \
  app npm test -- tests/reference-workbook.test.ts
```

The test only reads the workbook; it never writes it.
