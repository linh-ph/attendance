/**
 * Checks a real Supabase project against what this application needs.
 *
 * Run it after `docs/runbooks/supabase-auth-setup.md`, and again whenever
 * sign-in misbehaves — it separates "the project is not configured" from "the
 * application code is wrong", which otherwise both surface as a failed login.
 *
 *   docker compose run --rm app node scripts/verify-supabase.mjs
 *
 * It reads only. It never prints a key, and the one write it attempts (with the
 * service role, if present) is to a reserved all-zero user id that no real
 * account can hold, and is deleted again immediately.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;

/** A syntactically valid uuid that `auth.users` will never issue. */
const PROBE_USER = "00000000-0000-0000-0000-000000000000";

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "SKIP";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(path, { key, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: response.status, json, text };
}

if (!url || !publishable) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required.",
  );
  process.exit(1);
}

console.log(`Project: ${url}\n`);

// ---------------------------------------------------------------------------
// 1. The project answers, and the publishable key is accepted.
// ---------------------------------------------------------------------------

const settings = await call("/auth/v1/settings", { key: publishable });
record(
  "Auth service reachable with the publishable key",
  settings.status === 200,
  `HTTP ${settings.status}`,
);

// ---------------------------------------------------------------------------
// 2. The Google provider is enabled in the dashboard.
//
// This is the step no code can do for you, and the one most likely to be
// missed: without it `signInWithOAuth` returns a redirect that Supabase then
// refuses, which reads like an application bug.
// ---------------------------------------------------------------------------

const googleEnabled = settings.json?.external?.google === true;
record(
  "Google provider enabled",
  googleEnabled,
  googleEnabled ? "Authentication → Sign In / Providers" : "enable it in the Supabase dashboard",
);

// ---------------------------------------------------------------------------
// 2b. Google accepts the handoff.
//
// Enabling the provider only records a client id; it says nothing about whether
// Google will accept it, or whether the Supabase callback was added to the
// authorized redirect URIs. This walks the first hop of the real flow — no
// consent is granted and nobody is signed in — because the alternative is
// discovering a `redirect_uri_mismatch` from a person who cannot sign in.
// ---------------------------------------------------------------------------

if (googleEnabled) {
  const authorize = await fetch(
    `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${url}/auth/v1/callback`)}`,
    { redirect: "manual" },
  );
  const handoff = authorize.headers.get("location");

  if (!handoff?.startsWith("https://accounts.google.com/")) {
    record("Google accepts the OAuth handoff", false, `Supabase redirected to ${handoff ?? "nothing"}`);
  } else {
    const consent = await fetch(handoff, { redirect: "manual" });

    /*
     * A 302 is NOT success. Google refuses a bad client by *redirecting* to its
     * own error page, so status alone reports a rejected redirect URI as a
     * working handoff — the one wrong answer that matters, since it is the
     * failure this check exists to catch. The reason is base64 in `authError`.
     */
    const next = consent.headers.get("location") ?? "";
    const body = consent.status === 200 ? await consent.text() : "";
    const authError = new URL(next, "https://accounts.google.com").searchParams.get("authError");
    const reason = authError
      ? (Buffer.from(authError, "base64").toString("utf8").match(/[a-z_]{6,}/)?.[0] ?? "unknown")
      : "";

    const refused =
      next.includes("/signin/oauth/error") ||
      consent.status === 400 ||
      body.includes("redirect_uri_mismatch");

    record(
      "Google accepts the OAuth handoff",
      !refused,
      refused
        ? `Google refused it: ${reason || "see accounts.google.com error"}` +
          (reason === "redirect_uri_mismatch"
            ? ` — add ${url}/auth/v1/callback to the OAuth client's authorized redirect URIs (runbook step 1)`
            : "")
        : `Google served the consent screen (HTTP ${consent.status})`,
    );
  }
} else {
  record("Google accepts the OAuth handoff", null, "provider not enabled");
}

// ---------------------------------------------------------------------------
// 3. The schema is applied.
//
// An empty result and a missing table both look like "no rows" downstream, so
// this distinguishes them by status code: 200 means the table exists and RLS
// simply matched nothing for an anonymous caller.
// ---------------------------------------------------------------------------

const profiles = await call("/rest/v1/profiles?select=id&limit=1", { key: publishable });

/*
 * Proof of an actual database connection, taken from the answer above rather
 * than from a dedicated endpoint: PostgREST resolves a table name against a
 * schema cache it builds by introspecting the live database. So either a 200,
 * or a PGRST205 "not found in the schema cache", means it reached Postgres and
 * knows what is in it. Only a transport failure or a 5xx would not.
 *
 * The obvious check — GET /rest/v1/ for the OpenAPI document — is not used:
 * the project restricts it to authenticated roles and answers 401, which would
 * be reported as an outage when nothing is wrong.
 */
const introspected = profiles.status === 200 || profiles.json?.code === "PGRST205";
record(
  "Database reachable (PostgREST resolved the name against its schema cache)",
  introspected,
  introspected ? `HTTP ${profiles.status} from a live schema lookup` : `HTTP ${profiles.status}`,
);
record(
  "Table `profiles` exists",
  profiles.status === 200,
  profiles.status === 200
    ? `readable, ${profiles.json?.length ?? 0} row(s) visible to an anonymous caller`
    : `HTTP ${profiles.status} ${profiles.json?.message ?? ""} — run the migration`,
);

// ---------------------------------------------------------------------------
// 4. The credential table is unreachable by the browser key.
//
// This is a security assertion, not a connectivity one: a 200 here would mean
// encrypted Google refresh tokens are readable with a key that ships to every
// browser. It must fail, and failing to fail is the finding.
// ---------------------------------------------------------------------------

const credentials = await call("/rest/v1/google_credentials?select=user_id&limit=1", {
  key: publishable,
});

/*
 * 404 is NOT a pass. PostgREST answers 404 both for a table that is denied and
 * for a table that does not exist, so counting it as "denied" would report a
 * project with no schema at all as correctly locked down — the one wrong answer
 * that matters here, because it would look like proof and be the opposite.
 * Only 401/403 prove a table that exists and refuses.
 */
if (credentials.status === 401 || credentials.status === 403) {
  record(
    "Table `google_credentials` denied to the publishable key",
    true,
    `HTTP ${credentials.status} — RLS with no policy, as intended`,
  );
} else if (credentials.status === 404) {
  record(
    "Table `google_credentials` denied to the publishable key",
    null,
    "table does not exist yet — run the migration, then re-run this check",
  );
} else {
  record(
    "Table `google_credentials` denied to the publishable key",
    false,
    `HTTP ${credentials.status} — REFUSE TO SHIP: refresh tokens are browser-readable`,
  );
}

// ---------------------------------------------------------------------------
// 5. The service role can actually read and write it.
// ---------------------------------------------------------------------------

if (!serviceRole) {
  record("Service role reaches `google_credentials`", null, "SUPABASE_SERVICE_ROLE_KEY not set");
} else {
  const read = await call("/rest/v1/google_credentials?select=user_id&limit=1", {
    key: serviceRole,
  });
  record("Service role reads `google_credentials`", read.status === 200, `HTTP ${read.status}`);

  if (read.status === 200) {
    /*
     * A write is worth attempting because the read path would also pass on a
     * table whose grants were revoked too broadly. The foreign key to
     * auth.users means this probe is *expected* to be rejected — a 409 proves
     * the constraint is in place, which is itself the thing worth knowing.
     */
    const write = await call("/rest/v1/google_credentials", {
      key: serviceRole,
      method: "POST",
      body: { user_id: PROBE_USER, refresh_token: "v1.probe.probe.probe", scopes: [] },
      headers: { prefer: "return=minimal" },
    });

    if (write.status === 409) {
      record(
        "Write path reaches the table",
        true,
        "rejected by the foreign key to auth.users, as it should be",
      );
    } else if (write.status < 300) {
      await call(`/rest/v1/google_credentials?user_id=eq.${PROBE_USER}`, {
        key: serviceRole,
        method: "DELETE",
      });
      record("Write path reaches the table", true, "probe row written and removed");
    } else {
      record("Write path reaches the table", false, `HTTP ${write.status} ${write.json?.message ?? ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The encryption key is present and the right shape.
//
// Without it every sign-in stores nothing and every request refuses, so it is
// checked here rather than discovered by a person who cannot sign in.
// ---------------------------------------------------------------------------

if (!encryptionKey) {
  record("GOOGLE_TOKEN_ENCRYPTION_KEY set", false, "not set — the callback cannot store a token");
} else {
  // Must agree with readKey() in src/lib/supabase/token-crypto.ts: 64 hex
  // characters, or base64 that decodes to 32 bytes. Checking only base64 here
  // would report a perfectly good hex key as broken.
  const trimmed = encryptionKey.trim();
  const hex = /^[0-9a-f]{64}$/i.test(trimmed);
  const bytes = hex ? 32 : Buffer.from(trimmed, "base64").length;

  record(
    "GOOGLE_TOKEN_ENCRYPTION_KEY set",
    bytes === 32,
    hex ? "64 hex characters, 32 bytes" : `base64 decoding to ${bytes} bytes, needs 32`,
  );
}

// ---------------------------------------------------------------------------

const failed = results.filter((result) => result.ok === false);
const skipped = results.filter((result) => result.ok === null);

console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
);

process.exit(failed.length === 0 ? 0 : 1);
