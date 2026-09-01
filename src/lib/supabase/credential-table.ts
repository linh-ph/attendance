import { createClient } from "@supabase/supabase-js";
import type { EnvSource } from "@/lib/env";
import type { CredentialTable, StoredGoogleCredential } from "./google-credentials";

/**
 * The `google_credentials` table, reached with the service role.
 *
 * That key is required, not a shortcut: the table has Row Level Security
 * enabled with no policy and its grants revoked from `anon` and
 * `authenticated`, so the publishable key cannot read it even with a valid
 * session. The service role is the only key that can, and it never leaves the
 * server — it must never appear in a `NEXT_PUBLIC_` variable.
 *
 * `persistSession: false` matters here. This client is shared across requests
 * and must stay anonymous of any user session: it authorizes by key, and the
 * person it acts for is decided by the `userId` each call passes.
 */

const TABLE = "google_credentials";

export class SupabaseCredentialError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SupabaseCredentialError";
    this.cause = cause;
  }
}

export function hasServiceRole(env: EnvSource = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createSupabaseCredentialTable(
  env: EnvSource = process.env,
): CredentialTable {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    throw new SupabaseCredentialError(
      "Supabase credential storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  const client = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async read(userId): Promise<StoredGoogleCredential | null> {
      const { data, error } = await client
        .from(TABLE)
        .select("refresh_token, scopes")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        throw new SupabaseCredentialError("Could not read the stored Google connection.", error);
      }

      return data === null ? null : { refresh_token: data.refresh_token, scopes: data.scopes };
    },

    async write(userId, refreshToken, scopes): Promise<void> {
      const { error } = await client.from(TABLE).upsert(
        {
          user_id: userId,
          refresh_token: refreshToken,
          scopes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

      if (error) {
        throw new SupabaseCredentialError("Could not store the Google connection.", error);
      }
    },

    async remove(userId): Promise<void> {
      const { error } = await client.from(TABLE).delete().eq("user_id", userId);

      if (error) {
        throw new SupabaseCredentialError("Could not forget the Google connection.", error);
      }
    },
  };
}
