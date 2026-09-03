/**
 * Triggers a Vercel production deployment for one exact commit, and waits.
 *
 *   VERCEL_DEPLOY_SHA=<40-hex> node scripts/deploy-vercel.mjs [--target preview]
 *
 * Runs after `scripts/sync-vercel-env.mjs`, never beside it. Vercel resolves
 * environment variables when a deployment is *built*, so a deployment started
 * before the sync carries the previous environment — which is exactly the bug
 * this pipeline exists to prevent, and it would look like the sync silently
 * failing.
 *
 * Why deploy explicitly at all, when the project is linked to the GitHub repo:
 * a push-triggered deployment starts the moment the commit lands, in parallel
 * with CI. It therefore builds code nothing has verified yet, with whatever
 * environment predates this run. Deploying here, by SHA, after CI is green and
 * after the env sync, is the only ordering where "what is in production" and
 * "what passed CI" are the same commit.
 *
 * It resolves the repository from the project's own Git link rather than from
 * a hardcoded id, so moving or renaming the repository does not silently
 * deploy the wrong thing.
 */

const API = "https://api.vercel.com";

const token = process.env.VERCEL_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID?.trim() || "";
const sha = process.env.VERCEL_DEPLOY_SHA?.trim() || "";

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag === -1 ? "production" : process.argv[targetFlag + 1];

/** Resolves the project and its Git link, then stops before creating anything. */
const dryRun = process.argv.includes("--dry-run");

/** Long enough for a cold Next.js build, short enough to fail a stuck job. */
const TIMEOUT_MS = Number(process.env.VERCEL_DEPLOY_TIMEOUT_SECONDS ?? 1200) * 1000;
const POLL_MS = 10_000;

const TERMINAL = new Set(["READY", "ERROR", "CANCELED", "DELETED"]);

if (!token || !projectId) {
  console.error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required.");
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/i.test(sha)) {
  console.error(
    `VERCEL_DEPLOY_SHA must be a full 40-character commit sha, got ${sha ? `"${sha}"` : "nothing"}.\n` +
      "A short sha or a branch name would let Vercel resolve a different commit\n" +
      "than the one CI verified, which is the whole thing this guards.",
  );
  process.exit(1);
}

if (!["production", "preview"].includes(target)) {
  console.error(`--target must be production or preview, got "${target}".`);
  process.exit(1);
}

const scope = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";

async function api(path, { method = "GET", body } = {}) {
  const url = `${API}${path}${scope ? (path.includes("?") ? "&" : "?") + scope : ""}`;
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep `text` for the error message */
  }
  return { status: response.status, ok: response.ok, json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Resolve the project and its Git link.
// ---------------------------------------------------------------------------

const project = await api(`/v9/projects/${encodeURIComponent(projectId)}`);

if (!project.ok) {
  console.error(
    `Could not read project ${projectId}: HTTP ${project.status} ` +
      `${project.json?.error?.message ?? ""}\n` +
      (project.status === 403 || project.status === 404
        ? "A 403/404 here usually means the token is scoped to a different\n" +
          "account than the one that owns the project — set VERCEL_TEAM_ID.\n"
        : ""),
  );
  process.exit(1);
}

const link = project.json?.link;

if (!link || link.type !== "github" || !link.repoId) {
  console.error(
    "The Vercel project has no GitHub link, so there is no commit to deploy from.\n" +
      "Connect the repository in the Vercel dashboard (Settings -> Git).",
  );
  process.exit(1);
}

const ref = target === "production" ? (link.productionBranch ?? "main") : "main";

console.log(
  `Project    ${project.json.name}\n` +
    `Repository ${link.org}/${link.repo} (id ${link.repoId})\n` +
    `Target     ${target} on ${ref}\n` +
    `Commit     ${sha}\n`,
);

// ---------------------------------------------------------------------------
// Create the deployment.
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log("Dry run — the project and its Git link resolve. Nothing was deployed.");
  process.exit(0);
}

const created = await api("/v13/deployments?forceNew=1", {
  method: "POST",
  body: {
    name: project.json.name,
    project: projectId,
    target,
    gitSource: { type: "github", repoId: link.repoId, ref, sha },
  },
});

if (!created.ok) {
  console.error(
    `Failed to create the deployment: HTTP ${created.status} ` +
      `${created.json?.error?.message ?? created.text.slice(0, 400)}`,
  );
  process.exit(1);
}

const deploymentId = created.json?.id;
const inspectorUrl = created.json?.inspectorUrl ?? "";

console.log(`Created ${deploymentId}`);
if (inspectorUrl) console.log(`Logs    ${inspectorUrl}`);
console.log("");

// ---------------------------------------------------------------------------
// Wait for it to finish.
//
// Returning as soon as the deployment is queued would report success for a
// build that goes on to fail, which makes a green CD badge meaningless.
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let state = created.json?.readyState ?? created.json?.status ?? "QUEUED";
let lastLogged = "";

while (!TERMINAL.has(state)) {
  if (Date.now() - startedAt > TIMEOUT_MS) {
    console.error(
      `\nStill ${state} after ${Math.round(TIMEOUT_MS / 1000)}s. Giving up waiting.\n` +
        "The deployment itself is still running — follow it at the log URL above.\n" +
        "Raise VERCEL_DEPLOY_TIMEOUT_SECONDS if this project legitimately builds slower.",
    );
    process.exit(1);
  }

  await sleep(POLL_MS);

  const poll = await api(`/v13/deployments/${encodeURIComponent(deploymentId)}`);

  if (!poll.ok) {
    // A transient 5xx while polling is not a failed deployment. Keep waiting;
    // the timeout above is what ends a genuinely stuck run.
    console.log(`  (poll returned HTTP ${poll.status}, retrying)`);
    continue;
  }

  state = poll.json?.readyState ?? poll.json?.status ?? state;

  if (state !== lastLogged) {
    console.log(`  ${state}  (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    lastLogged = state;
  }
}

const finished = await api(`/v13/deployments/${encodeURIComponent(deploymentId)}`);
const url = finished.json?.url ? `https://${finished.json.url}` : "";
const aliases = finished.json?.alias ?? [];

if (state !== "READY") {
  console.error(
    `\nDeployment finished ${state}.\n` +
      (finished.json?.errorMessage ? `${finished.json.errorMessage}\n` : "") +
      (inspectorUrl ? `Build logs: ${inspectorUrl}\n` : ""),
  );
  process.exit(1);
}

console.log(
  `\nREADY in ${Math.round((Date.now() - startedAt) / 1000)}s\n` +
    (url ? `Deployment ${url}\n` : "") +
    (aliases.length > 0 ? `Aliases    ${aliases.map((a) => `https://${a}`).join(", ")}\n` : ""),
);

/*
 * Hand the address to the workflow so the next step can prove the deployment
 * actually serves traffic. The alias is preferred over the per-deployment url:
 * for a production deploy that is the domain people will use, and a build can
 * succeed while the alias assignment does not.
 */
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  const live = aliases.length > 0 ? `https://${aliases[0]}` : url;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `url=${url}\nalias=${live}\ndeployment_id=${deploymentId}\n`,
  );
}
