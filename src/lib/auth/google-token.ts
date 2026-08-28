export type RefreshError = "RefreshAccessTokenError";

export type GoogleToken = Record<string, unknown> & {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: RefreshError;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
};

export type TokenFetch = (
  input: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<TokenResponse> }>;

const REFRESH_ERROR: RefreshError = "RefreshAccessTokenError";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function refreshError(token: GoogleToken): GoogleToken {
  return { ...token, error: REFRESH_ERROR };
}

export async function refreshGoogleToken(
  token: GoogleToken,
  fetcher: TokenFetch = fetch,
  now: () => number = Date.now,
): Promise<GoogleToken> {
  if (token.expiresAt !== undefined && token.expiresAt > now()) {
    return token;
  }

  if (!token.refreshToken) {
    return refreshError(token);
  }

  try {
    const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID ?? "",
        client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }).toString(),
    });
    const refreshed = await response.json();

    if (!response.ok || !refreshed.access_token || !refreshed.expires_in) {
      return refreshError(token);
    }

    const { error: _refreshError, ...preservedClaims } = token;

    return {
      ...preservedClaims,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      expiresAt: now() + refreshed.expires_in * 1000,
    };
  } catch {
    return refreshError(token);
  }
}
