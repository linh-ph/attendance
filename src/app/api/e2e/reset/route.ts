import { encode } from "next-auth/jwt";
import { usesSecureCookie } from "@/lib/auth/session";
import {
  E2E_FIXTURE,
  resetFakeGoogleStore,
  toTestAccessToken,
} from "@/lib/testing/fake-google-store";
import {
  PRODUCTION_TEST_MODE_MESSAGE,
  isTestSecretAccepted,
  resolveTestMode,
} from "@/lib/testing/runtime-guard";

export const dynamic = "force-dynamic";

/**
 * Deterministic browser-proof control endpoint.
 *
 * Two independent conditions must both hold before this route does anything:
 * the runtime guard must allow the non-production adapter, and the request must
 * present the shared `X-E2E-Secret`. Anything else answers `404` with an empty
 * body — never `403` — so a probe cannot even learn that the route exists.
 *
 * The identity it mints is a genuine Auth.js session JWT for the requested
 * fixture user. That is deliberate: no product session, proxy, page, or Route
 * Handler is modified or bypassed, and every request the browser then makes is
 * authorized by exactly the committed rules. The access token inside that JWT
 * carries the deterministic `e2e:<email>` marker the gateway factory reads.
 */

const NOT_FOUND_HEADERS = { "Cache-Control": "no-store" } as const;

const SECRET_HEADER = "x-e2e-secret";

/** Auth.js reads this cookie, and its name is also the JWT encryption salt. */
const SESSION_COOKIE = "authjs.session-token";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

/** Browser-visible marker of which fixture user this context is signed in as. */
const IDENTITY_COOKIE = "e2e-user";

const SESSION_MAX_AGE_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(null, { status: 404, headers: NOT_FOUND_HEADERS });
}

interface ResetBody {
  signInAs?: unknown;
  attendanceSaveFailures?: unknown;
  inviteFailures?: unknown;
}

async function readBody(request: Request): Promise<ResetBody> {
  try {
    const parsed: unknown = await request.json();
    return parsed !== null && typeof parsed === "object" ? (parsed as ResetBody) : {};
  } catch {
    return {};
  }
}

function readEmails(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function cookie(name: string, value: string, secure: boolean): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];

  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Mints the same encrypted Auth.js JWT a real Google sign-in would leave behind.
 *
 * `expiresAt` is far enough ahead that the committed refresh callback returns
 * the token untouched, so no outbound Google token request is ever attempted.
 */
async function signInCookies(email: string, request: Request): Promise<string[] | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const secure = usesSecureCookie(request);
  const cookieName = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;

  const token = await encode({
    secret,
    salt: cookieName,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      email,
      sub: email,
      name: email,
      accessToken: toTestAccessToken(email),
      refreshToken: "e2e-refresh-token",
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    },
  });

  return [
    cookie(cookieName, encodeURIComponent(token), secure),
    cookie(IDENTITY_COOKIE, encodeURIComponent(email), secure),
  ];
}

/**
 * `POST /api/e2e/reset`
 *
 * Reseeds the deterministic Drive/Sheets store and, when `signInAs` is given,
 * signs the calling browser context in as that fixture user.
 */
export async function POST(request: Request): Promise<Response> {
  let isTestMode: boolean;

  try {
    isTestMode = resolveTestMode(process.env);
  } catch {
    // A production build with the flag set must fail closed and stay silent
    // about this route; the refusal itself is still recorded server-side.
    console.error(`[e2e] ${PRODUCTION_TEST_MODE_MESSAGE}`);
    return notFound();
  }

  if (!isTestMode) return notFound();
  if (!isTestSecretAccepted(process.env, request.headers.get(SECRET_HEADER))) return notFound();

  const body = await readBody(request);

  const fixture = resetFakeGoogleStore({
    attendanceSaveFailures: readCount(body.attendanceSaveFailures),
    inviteFailures: readEmails(body.inviteFailures),
  });

  const headers = new Headers(NOT_FOUND_HEADERS);
  headers.set("Content-Type", "application/json");

  let signedInAs: string | null = null;

  if (typeof body.signInAs === "string" && body.signInAs.trim() !== "") {
    const email = body.signInAs.trim().toLowerCase();
    const cookies = await signInCookies(email, request);

    if (cookies === null) {
      return Response.json(
        { error: "AUTH_SECRET is required to mint a deterministic session." },
        { status: 500, headers: NOT_FOUND_HEADERS },
      );
    }

    for (const value of cookies) headers.append("Set-Cookie", value);
    signedInAs = email;
  }

  return new Response(JSON.stringify({ signedInAs, fixture: E2E_FIXTURE }), {
    status: 200,
    headers,
  });
}
