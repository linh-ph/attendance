import type { RefreshError } from "@/lib/auth/google-token";

declare module "next-auth" {
  interface Session {
    user?: { email: string };
    error?: RefreshError;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: RefreshError;
  }
}

export {};
