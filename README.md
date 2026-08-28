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
# Build the test image and run the checks
docker compose build test
docker compose run --rm test npm run lint
docker compose run --rm test npm run typecheck
docker compose run --rm test npm test
docker compose run --rm test npm run verify   # lint + typecheck + test + build

# Build and start the production image
docker compose build app
docker compose up --detach app

# Readiness
curl http://localhost:3000/api/health          # {"status":"ok"}

# Stop only this Compose project
docker compose down
```

The `test` service bind-mounts the working tree and keeps `/app/node_modules` in
a named volume, so focused test runs pick up current files without rebuilding
the image. The `app` service runs the standalone Next.js build as a non-root
user on port 3000.

## Optional: prove the supplied reference workbook

`tests/reference-workbook.test.ts` checks the real `202607勤怠管理表.xlsx`
against the workbook contract. The workbook is not committed, so the suite runs
only when `REFERENCE_XLSX_PATH` points at a readable copy and is skipped
otherwise. Mount the file read-only rather than copying it into the repository:

```bash
docker compose run --rm \
  -v "/absolute/path/to/202607勤怠管理表.xlsx:/ref.xlsx:ro" \
  --env REFERENCE_XLSX_PATH=/ref.xlsx \
  test npm test -- tests/reference-workbook.test.ts
```

The test only reads the workbook; it never writes it.

> `vitest.config.ts` currently collects `src/**/*.test.ts(x)` only, so the
> command above reports `No test files found` until `tests/**/*.test.ts` is
> added to that `include` list. Until then the suite can be exercised with a
> temporary config that widens `include`; a normal `npm test` is unaffected.
