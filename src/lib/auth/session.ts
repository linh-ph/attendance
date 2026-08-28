import { getToken, type JWT } from "next-auth/jwt";
import type { GoogleToken, RefreshError } from "./google-token";

export type BrowserSession = {
  user?: { email: string };
  expires: string;
  error?: RefreshError;
};

type SessionInput = {
  user?: { email?: string | null } | null;
};

export type GoogleSession = {
  email: string;
  accessToken: string;
};

type GoogleSessionInput = {
  session: SessionInput | null;
  token: GoogleToken | null;
};

export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "UnauthenticatedError";
  }
}

function normalizedEmail(email: string | null | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

export async function requireGoogleSession({
  session,
  token,
}: GoogleSessionInput): Promise<GoogleSession> {
  const email = normalizedEmail(session?.user?.email);
  if (!email || !token?.accessToken || token.error === "RefreshAccessTokenError") {
    throw new UnauthenticatedError();
  }

  return { email, accessToken: token.accessToken };
}

export function toBrowserSession(
  session: SessionInput & { expires: string },
  token: GoogleToken,
): BrowserSession {
  const email = normalizedEmail(session.user?.email);

  return {
    ...(email ? { user: { email } } : {}),
    expires: session.expires,
    ...(token.error ? { error: token.error } : {}),
  };
}

type JwtReader = (params: {
  req: Request;
  secret: string;
  secureCookie: boolean;
}) => Promise<JWT | null>;

export async function requireGoogleSessionFromRequest(
  request: Request,
  readJwt: JwtReader = getToken,
): Promise<GoogleSession> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new UnauthenticatedError();
  }

  const token = await readJwt({
    req: request,
    secret,
    secureCookie: process.env.AUTH_URL?.startsWith("https://") ?? false,
  });

  return requireGoogleSession({
    session: { user: { email: token?.email as string | null | undefined } },
    token: token as GoogleToken | null,
  });
}

export function toApiErrorResponse(error: unknown): Response | undefined {
  if (error instanceof UnauthenticatedError) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return undefined;
}
