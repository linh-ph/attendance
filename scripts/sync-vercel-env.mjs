/**
 * Pushes this application's runtime environment into the Vercel project.
 *
 *   node scripts/sync-vercel-env.mjs [--dry-run]
 *
 * Reads `scripts/deploy-env.manifest` for the list, and each value from its own
 * process environment — in CD that is a GitHub secret, locally it is whatever
 * you exported. It writes to Vercel over the REST API and then re-reads the
 * project to prove each name landed on each target.
 *
 * It never prints a value. Every log line is a name, a target list, and an
 * outcome; the summary at the end is counts. That is deliberate: this script's
 * whole input is secrets, and GitHub Actions logs are readable by anyone with
 * repository access. `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security
 * entirely and `GOOGLE_TOKEN_ENCRYPTION_KEY` decrypts every stored Google
 * connection — neither may ever reach a log line.
 *
 * Ordering matters and is not an implementation detail: Vercel resolves
 * environment variables when a deployment is *built*, so a value written after
 * a build is not in that build. `scripts/deploy-vercel.mjs` runs after this,
 * never beside it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "deploy-env.manifest");

const API = "https://api.vercel.com";

/**
 * Both Vercel targets get the same values, which matches the eight variables
 * this project already had before the pipeline existed. See the AUTH_URL note
 * in docs/runbooks/deployment.md for the one place that is a compromise.
 */
const TARGETS = ["production", "preview"];

/**
 * `sensitive` is write-only: Vercel will hand the value to a build and to the
 * running function, and to nothing else — not the dashboard, not this API, not
 * a later run of this script. `encrypted` is the fallback for accounts where
 * sensitive variables are unavailable; it is still encrypted at rest, it is
 * merely readable back by someone holding a project token.
 */
const PREFERRED_TYPE = "sensitive";
const FALLBACK_TYPE = "encrypted";

const dryRun = process.argv.includes("--dry-run");

const token = process.env.VERCEL_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID?.trim() || "";

if (!token || !projectId) {
  console.error(
    "VERCEL_TOKEN and VERCEL_PROJECT_ID are required.\n" +
      "Both are `deploy` scope in scripts/deploy-env.manifest; push them with\n" +
      "  ./scripts/push-github-secrets.sh",
  );
  process.exit(1);
}

/** Appended to every request. A team-scoped token resolves without it. */
const scope = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";

function withScope(path) {
  if (!scope) return `${API}${path}`;
  return `${API}${path}${path.includes("?") ? "&" : "?"}${scope}`;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(withScope(path), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Vercel answers HTML on some gateway errors; `text` still carries it. */
  }

  return { status: response.status, ok: response.ok, json, text };
}

// ---------------------------------------------------------------------------
// The manifest.
// ---------------------------------------------------------------------------

/** @returns {{name: string, scope: string, requirement: string}[]} */
function readManifest() {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, entryScope, requirement] = line.split(/\s+/);
      return { name, scope: entryScope, requirement };
    });
}

const manifest = readManifest();

/*
 * A malformed manifest must stop the run rather than silently drop a variable.
 * A typo in the scope column would otherwise mean a required secret is never
 * synced, and the only symptom is a 500 from production days later.
 */
const malformed = manifest.filter(
  (entry) =>
    !["runtime", "deploy"].includes(entry.scope) ||
    !["required", "optional"].includes(entry.requirement),
);

if (malformed.length > 0) {
  console.error(
    `scripts/deploy-env.manifest has ${malformed.length} malformed entr(y/ies): ` +
      malformed.map((entry) => entry.name).join(", "),
  );
  process.exit(1);
}

/*
 * `deploy` scope stops here by design. VERCEL_TOKEN can redeploy this project
 * and read every environment variable in it; the running application has no
 * use for that and must not be able to reach it.
 */
const runtime = manifest.filter((entry) => entry.scope === "runtime");

// ---------------------------------------------------------------------------
// What we have, and what is missing.
// ---------------------------------------------------------------------------

const present = [];
const skipped = [];
const missing = [];

for (const entry of runtime) {
  const value = process.env[entry.name];

  if (value === undefined || value === "") {
    (entry.requirement === "required" ? missing : skipped).push(entry.name);
    continue;
  }

  present.push({ name: entry.name, value });
}

if (missing.length > 0) {
  console.error(
    `Missing required value(s): ${missing.join(", ")}\n\n` +
      "In CD these come from GitHub repository secrets. Push them from your\n" +
      "local .env (with a .env.production overlay for anything that differs in\n" +
      "production) using:\n\n" +
      "  ./scripts/push-github-secrets.sh\n",
  );
  process.exit(1);
}

console.log(
  `Project ${projectId}${teamId ? ` (team ${teamId})` : ""}\n` +
    `${present.length} variable(s) to sync, ${skipped.length} optional and unset` +
    (dryRun ? "  [DRY RUN — nothing will be written]" : "") +
    "\n",
);

/*
 * An optional variable with no value is not "leave whatever is there". The
 * secrets are the source of truth for the whole runtime environment, so an
 * absent one must be REMOVED from the project — otherwise a value that was
 * deliberately cleared upstream keeps running in production forever.
 *
 * This is exactly the APP_DEBUG_ERRORS case: clearing it locally and pushing
 * would, without this, leave the old `1` in Vercel and keep server-side error
 * disclosure on. Names outside the manifest are never touched — this pipeline
 * only owns what it declares.
 */
for (const name of skipped) {
  console.log(`UNSET   ${name} — optional and not set; will be removed if present`);
}

// ---------------------------------------------------------------------------
// Write.
// ---------------------------------------------------------------------------

/*
 * `upsert=true` is what makes this idempotent. Without it Vercel answers 409
 * for a name that already exists, and the alternative — delete then create —
 * leaves the project with the variable absent for the width of two API calls,
 * which a concurrent build would pick up.
 */
async function upsert(name, value, type) {
  return api(`/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, {
    method: "POST",
    body: { key: name, value, type, target: TARGETS },
  });
}

let type = PREFERRED_TYPE;
let failures = 0;

for (const { name, value } of present) {
  if (dryRun) {
    console.log(`WOULD   ${name} -> ${TARGETS.join(", ")}`);
    continue;
  }

  let response = await upsert(name, value, type);

  /*
   * Some accounts reject `sensitive`. Detect it once, on the first variable,
   * and carry the fallback for the rest of the run rather than retrying every
   * name — a per-name retry would leave the project split across two types.
   */
  if (!response.ok && type === PREFERRED_TYPE && /sensitive/i.test(response.text)) {
    console.log(`NOTE    this account rejects '${PREFERRED_TYPE}'; using '${FALLBACK_TYPE}'`);
    type = FALLBACK_TYPE;
    response = await upsert(name, value, type);
  }

  if (response.ok) {
    console.log(`OK      ${name} -> ${TARGETS.join(", ")}  (${type})`);
    continue;
  }

  failures += 1;
  // `response.json.error.message` is Vercel's own text and never echoes the
  // value we sent — only the key and the reason.
  console.error(
    `FAIL    ${name} — HTTP ${response.status} ${response.json?.error?.message ?? ""}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} variable(s) failed to write. Not deploying.`);
  process.exit(1);
}

if (dryRun) {
  for (const name of skipped) console.log(`WOULD   remove ${name} if present`);
  console.log("\nDry run complete. Nothing was written.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Re-read the project. This serves two purposes: finding cleared variables to
// remove, and proving the writes above landed.
//
// A 200 from a write is Vercel accepting the request. What a later build
// actually depends on is the name being present on the target, which is what
// this checks. Values cannot be checked — that is the point of `sensitive` —
// so this asserts presence and reach, not content.
// ---------------------------------------------------------------------------

const listing = await api(`/v10/projects/${encodeURIComponent(projectId)}/env?decrypt=false`);

if (!listing.ok) {
  console.error(`\nCould not re-read the project env to verify: HTTP ${listing.status}`);
  process.exit(1);
}

const byName = new Map((listing.json?.envs ?? []).map((env) => [env.key, env]));

for (const name of skipped) {
  const stale = byName.get(name);
  if (!stale) continue;

  const removed = await api(
    `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(stale.id)}`,
    { method: "DELETE" },
  );

  if (removed.ok) {
    console.log(`REMOVED ${name} — was set on Vercel, is not set upstream`);
    byName.delete(name);
  } else {
    failures += 1;
    console.error(
      `FAIL    ${name} (remove) — HTTP ${removed.status} ${removed.json?.error?.message ?? ""}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} variable(s) could not be removed. Not deploying.`);
  process.exit(1);
}

const unverified = [];

for (const { name } of present) {
  const found = byName.get(name);
  const reaches = found ? TARGETS.every((target) => (found.target ?? []).includes(target)) : false;
  if (!reaches) {
    unverified.push(`${name} (${found ? `only ${(found.target ?? []).join(", ")}` : "absent"})`);
  }
}

if (unverified.length > 0) {
  console.error(`\nVerification failed for: ${unverified.join("; ")}`);
  process.exit(1);
}

console.log(
  `\nVerified: ${present.length} variable(s) present on ${TARGETS.join(" and ")}.\n` +
    "These apply to deployments BUILT from now on, not to existing ones — which\n" +
    "is why scripts/deploy-vercel.mjs runs after this and never beside it.",
);
