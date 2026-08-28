# Google Sheets Attendance

An English-language attendance application backed by Google Sheets.

## Run and verify

Copy `.env.example` to `.env`, supply Google OAuth and Picker values when those
features are implemented, then use Docker Compose:

```bash
docker compose build test
docker compose run --rm test npm run verify
docker compose up --build app
```

The unauthenticated readiness endpoint is available at
`http://localhost:3000/api/health`.

## Environment

`.env` is local-only. Keep secrets out of version control; `.env.example`
documents the required variable names.
