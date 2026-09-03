#!/usr/bin/env bash
#
# Pushes the environment this application needs from your machine into the
# GitHub repository's Actions secrets, where CI and CD read it.
#
#   ./scripts/push-github-secrets.sh [--dry-run] [--yes] [--repo owner/name]
#
# The list comes from scripts/deploy-env.manifest — the same file the Vercel
# sync reads, so the two cannot drift.
#
# Values are read from two files, later wins:
#
#   .env              your local development values
#   .env.production   overrides for anything that differs in production
#
# That overlay is not bureaucracy. `.env` in this repository holds
# AUTH_URL=http://localhost:3000 and APP_DEBUG_ERRORS=1, and promoting either
# to production breaks it: the first sends every OAuth redirect to a machine
# Google cannot reach, the second turns on server-side error disclosure. The
# refusals below stop exactly that, and .env.production is where the real
# values go. Both files are gitignored.
#
# A key written EMPTY in .env.production means "explicitly unset in production"
# — it does not fall back to .env. Such a key is not pushed, and any existing
# secret of that name is deleted, so the intent reaches Vercel instead of being
# quietly overridden by a stale value.
#
# No value is ever printed, and none is passed as a command-line argument —
# every secret goes to `gh` on stdin, so it never appears in `ps` output.
#
# bash 3.2 compatible on purpose: that is what macOS ships. No associative
# arrays, no `mapfile`.

set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST="scripts/deploy-env.manifest"
ENV_FILE=".env"
ENV_PRODUCTION=".env.production"

dry_run=0
assume_yes=0
allow_dev_values=0
repo=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes|-y) assume_yes=1 ;;
    --allow-dev-values) allow_dev_values=1 ;;
    --repo) repo="${2:-}"; shift ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Try --help." >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Preconditions.
# ---------------------------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI (gh) is not installed. https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run:  gh auth login" >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "Missing $MANIFEST — run this from the repository." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ] && [ ! -f "$ENV_PRODUCTION" ]; then
  echo "Neither $ENV_FILE nor $ENV_PRODUCTION exists. Nothing to push." >&2
  echo "Start from .env.example and .env.production.example." >&2
  exit 1
fi

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

# ---------------------------------------------------------------------------
# Reading a dotenv file.
#
# Deliberately not `source`: these files hold base64 keys and OAuth secrets, and
# sourcing them would let a `$` or a backtick in any value execute as code, as
# well as mangling anything containing whitespace.
#
# `key_defined` and `read_value` are separate because the difference between
# "absent" and "present but empty" carries meaning here — the first falls back
# to .env, the second deliberately does not.
# ---------------------------------------------------------------------------

matching_line() { # matching_line KEY FILE ; last definition wins, as dotenv does
  [ -f "$2" ] || return 1
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$2" | tail -n 1
}

key_defined() {
  local line
  line="$(matching_line "$1" "$2" || true)"
  [ -n "$line" ]
}

read_value() { # prints the value, which may legitimately be empty
  local line value
  line="$(matching_line "$1" "$2" || true)"
  [ -n "$line" ] || return 1

  value="${line#*=}"
  value="${value%$'\r'}"

  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac

  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Refusals.
#
# A development value that reaches production does not fail loudly — it fails
# as a person who cannot sign in, or as internal error detail on a public page.
# ---------------------------------------------------------------------------

refuse() { # prints a reason and returns 0 when the value must not ship
  local key="$1" value="$2"

  case "$key" in
    AUTH_URL)
      case "$value" in
        *localhost*|*127.0.0.1*|*0.0.0.0*)
          echo "it points at your own machine — production OAuth callbacks would never arrive"
          return 0
          ;;
        https://*) ;;
        *)
          echo "production must be https:// — Auth.js session cookies are Secure"
          return 0
          ;;
      esac
      ;;
    APP_DEBUG_ERRORS)
      if [ "$value" = "1" ]; then
        echo "1 turns on server-side error disclosure; set it empty in $ENV_PRODUCTION"
        return 0
      fi
      ;;
  esac

  return 1
}

# ---------------------------------------------------------------------------
# Resolve every manifest entry. Line-delimited lists rather than associative
# arrays, so this runs on the bash 3.2 that macOS ships.
# ---------------------------------------------------------------------------

to_set=""     # "NAME SCOPE SOURCE_FILE"
to_clear=""   # names explicitly unset for production
skipped=""
problems=""

while read -r name scope requirement; do
  case "$name" in ''|'#'*) continue ;; esac

  if key_defined "$name" "$ENV_PRODUCTION"; then
    source_file="$ENV_PRODUCTION"
  elif key_defined "$name" "$ENV_FILE"; then
    source_file="$ENV_FILE"
  else
    if [ "$requirement" = "required" ]; then
      problems="${problems}  ${name} — required, not set in $ENV_PRODUCTION or $ENV_FILE"$'\n'
    else
      skipped="${skipped}  ${name} — optional, not set anywhere"$'\n'
    fi
    continue
  fi

  value="$(read_value "$name" "$source_file")"

  if [ -z "$value" ]; then
    if [ "$requirement" = "required" ]; then
      problems="${problems}  ${name} — required, but empty in ${source_file}"$'\n'
    else
      # Present and empty is an instruction, not an omission: do not fall back
      # to .env, and remove any secret already carrying the old value.
      to_clear="${to_clear}${name}"$'\n'
    fi
    continue
  fi

  if reason="$(refuse "$name" "$value")"; then
    if [ "$allow_dev_values" -eq 1 ]; then
      echo "WARNING  ${name} from ${source_file}: ${reason}  (--allow-dev-values)" >&2
    else
      problems="${problems}  ${name} (from ${source_file}) — ${reason}"$'\n'
      continue
    fi
  fi

  to_set="${to_set}${name} ${scope} ${source_file}"$'\n'
done < <(grep -vE '^[[:space:]]*(#|$)' "$MANIFEST")

# Only clear a secret that actually exists, so the plan reflects reality.
#
# Not swallowed with `|| true`: if this call fails, every deletion would be
# silently skipped and the run would report success while leaving the stale
# value in place — the exact outcome the clearing logic exists to prevent.
if ! existing_secrets="$(gh secret list --repo "$repo" --json name --jq '.[].name')"; then
  echo "Could not list existing secrets on ${repo}." >&2
  echo "Check that the account has admin access to the repository." >&2
  exit 1
fi

to_delete=""
while read -r name; do
  [ -n "$name" ] || continue
  if printf '%s\n' "$existing_secrets" | grep -qx "$name"; then
    to_delete="${to_delete}${name}"$'\n'
  else
    skipped="${skipped}  ${name} — explicitly unset for production, no secret to remove"$'\n'
  fi
done <<EOF
$(printf '%s' "$to_clear")
EOF

# ---------------------------------------------------------------------------
# Report before doing anything.
# ---------------------------------------------------------------------------

echo "Repository  ${repo}"
if [ -f "$ENV_PRODUCTION" ]; then
  echo "Sources     ${ENV_FILE} + ${ENV_PRODUCTION} (overlay wins)"
else
  echo "Sources     ${ENV_FILE}  (no ${ENV_PRODUCTION})"
fi
echo ""

if [ -n "$to_set" ]; then
  echo "Will set:"
  while read -r name scope source_file; do
    [ -n "$name" ] || continue
    printf '  %-42s %-8s from %s\n' "$name" "$scope" "$source_file"
  done <<EOF
$(printf '%s' "$to_set")
EOF
  echo ""
fi

if [ -n "$to_delete" ]; then
  echo "Will DELETE (explicitly unset for production):"
  while read -r name; do
    [ -n "$name" ] || continue
    printf '  %s\n' "$name"
  done <<EOF
$(printf '%s' "$to_delete")
EOF
  echo ""
fi

if [ -n "$skipped" ]; then
  echo "Skipping:"
  printf '%s' "$skipped"
  echo ""
fi

if [ -n "$problems" ]; then
  echo "Refusing to push — fix these first:" >&2
  printf '%s' "$problems" >&2
  echo "" >&2
  echo "Put production values in ${ENV_PRODUCTION} (gitignored; see ${ENV_PRODUCTION}.example)." >&2
  echo "It overrides ${ENV_FILE} for exactly the keys it defines; an empty value there" >&2
  echo "means 'unset in production' rather than 'fall back to ${ENV_FILE}'." >&2
  exit 1
fi

if [ -z "$to_set" ] && [ -z "$to_delete" ]; then
  echo "Nothing to do."
  exit 0
fi

set_count="$(printf '%s' "$to_set" | grep -c . || true)"
delete_count="$(printf '%s' "$to_delete" | grep -c . || true)"

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run — ${set_count} to set, ${delete_count} to delete. Nothing was written."
  exit 0
fi

if [ "$assume_yes" -ne 1 ]; then
  # Writing to a shared repository is outward-facing and overwrites whatever is
  # there now; GitHub keeps no history of a secret's previous value.
  printf 'Set %s and delete %s secret(s) on %s? [y/N] ' "$set_count" "$delete_count" "$repo"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
  echo ""
fi

# ---------------------------------------------------------------------------
# Write. Values go over stdin, never argv.
#
# Both loops are fed by a heredoc rather than a pipe: a piped `while` runs in a
# subshell, and `failed` would be discarded when it exits — the script would
# report every secret as fine no matter how many failed.
# ---------------------------------------------------------------------------

failed=0

while read -r name scope source_file; do
  [ -n "$name" ] || continue

  value="$(read_value "$name" "$source_file")"

  if printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null 2>&1; then
    echo "SET     ${name}"
  else
    echo "FAIL    ${name}" >&2
    failed=$((failed + 1))
  fi
done <<EOF
$(printf '%s' "$to_set")
EOF

while read -r name; do
  [ -n "$name" ] || continue

  if gh secret delete "$name" --repo "$repo" >/dev/null 2>&1; then
    echo "DELETE  ${name}"
  else
    echo "FAIL    ${name} (delete)" >&2
    failed=$((failed + 1))
  fi
done <<EOF
$(printf '%s' "$to_delete")
EOF

echo ""

if [ "$failed" -gt 0 ]; then
  echo "${failed} secret(s) failed." >&2
  exit 1
fi

echo "Done on ${repo}: ${set_count} set, ${delete_count} deleted."
echo ""
echo "CI reads the Supabase ones to prove the project answers before a deploy."
echo "CD reads all of them and syncs the 'runtime' ones into Vercel."
echo "Verify with:  gh secret list --repo ${repo}"
