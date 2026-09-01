import { refreshGoogleToken, type TokenFetch } from "@/lib/auth/google-token";
import { decryptToken, encryptToken, readKey } from "./token-crypto";

/**
 * The custodian of one Google refresh token per person.
 *
 * Supabase Auth hands back `provider_refresh_token` **once**, at sign-in, and
 * never refreshes the Google token afterwards. This application calls Drive and
 * Sheets on the person's own authority for as long as they are signed in, so
 * the refresh token has to be kept somewhere and exchanged when the access
 * token expires. That is what this module does, and it is the whole cost of the
 * decision recorded in
 * `docs/decisions/2026-09-02-supabase-holds-google-credentials.md`.
 *
 * Three rules hold it in place:
 *
 * 1. **The token is encrypted before it leaves this process** and decrypted
 *    only here. The database never sees a usable credential, and the key is not
 *    in the database.
 * 2. **Only the service role reaches the table.** RLS on `google_credentials`
 *    has no policy, so no browser key can read it even with a valid session.
 * 3. **Nothing here is returned to a caller except a short-lived access token.**
 *    A refresh token never leaves this module.
 *
 * Node-only: it decrypts with `node:crypto`, so it must not be imported from
 * the Edge proxy.
 */

export interface StoredGoogleCredential {
  /** The AES-256-GCM envelope, exactly as the table holds it. */
  refresh_token: string;
  scopes: string[];
}

/**
 * The narrow slice of Supabase this module needs, so the tests can supply a
 * fake instead of a project.
 */
export interface CredentialTable {
  read(userId: string): Promise<StoredGoogleCredential | null>;
  write(userId: string, refreshToken: string, scopes: string[]): Promise<void>;
  remove(userId: string): Promise<void>;
}

export interface GoogleCredentialsOptions {
  table: CredentialTable;
  /** Base64, 32 bytes. Defaults to `GOOGLE_TOKEN_ENCRYPTION_KEY`. */
  encryptionKey?: string;
  fetcher?: TokenFetch;
  now?: () => number;
}

export class GoogleCredentialError extends Error {
  readonly code: "not-connected" | "refresh-failed";

  constructor(code: "not-connected" | "refresh-failed", message: string) {
    super(message);
    this.name = "GoogleCredentialError";
    this.code = code;
  }
}

export interface GoogleCredentials {
  /** Stores the refresh token Supabase returned at sign-in. */
  connect(userId: string, refreshToken: string, scopes: string[]): Promise<void>;
  /** A live Google access token for this person, refreshed if it has expired. */
  accessTokenFor(userId: string): Promise<string>;
  /** Forgets the credential — sign-out, or a revoked grant. */
  disconnect(userId: string): Promise<void>;
}

export function createGoogleCredentials(options: GoogleCredentialsOptions): GoogleCredentials {
  const { table } = options;
  const now = options.now ?? Date.now;
  const key = () => readKey(options.encryptionKey ?? process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);

  return {
    async connect(userId, refreshToken, scopes) {
      await table.write(userId, encryptToken(refreshToken, key()), scopes);
    },

    async disconnect(userId) {
      await table.remove(userId);
    },

    async accessTokenFor(userId) {
      const stored = await table.read(userId);
      if (stored === null) {
        // Never signed in with Google, or the grant was forgotten. The caller
        // sends the person back through consent; it is not a server fault.
        throw new GoogleCredentialError(
          "not-connected",
          "This account has no Google connection stored. Sign in again.",
        );
      }

      const refreshToken = decryptToken(stored.refresh_token, key());

      /*
       * `expiresAt` is deliberately omitted so the exchange always happens.
       * Access tokens are not cached here: the alternative is a second piece of
       * mutable state to keep in step with the database, and Google's token
       * endpoint is cheap next to the Drive and Sheets calls that follow.
       */
      const refreshed = await refreshGoogleToken(
        { refreshToken },
        options.fetcher ?? fetch,
        now,
      );

      if (refreshed.error !== undefined || !refreshed.accessToken) {
        throw new GoogleCredentialError(
          "refresh-failed",
          "Google refused to refresh this connection. Sign in again.",
        );
      }

      /*
       * Google returns a new refresh token only when it rotates one. Persisting
       * it when it changes is what keeps a long-lived session working; skipping
       * it when it has not changed avoids a write on every request.
       */
      if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
        await table.write(userId, encryptToken(refreshed.refreshToken, key()), stored.scopes);
      }

      return refreshed.accessToken;
    },
  };
}
