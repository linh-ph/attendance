import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { refreshGoogleToken } from "@/lib/auth/google-token";
import { toBrowserSession } from "@/lib/auth/session";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;

const publicPaths = new Set(["/", "/login", "/api/health"]);

export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          access_type: "offline",
          prompt: "consent",
          scope: GOOGLE_SCOPES.join(" "),
        },
      },
    }),
  ],
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at ? account.expires_at * 1000 : Date.now(),
        };
      }

      return refreshGoogleToken(token);
    },
    session({ session, token }) {
      return toBrowserSession(session, token);
    },
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      return publicPaths.has(path) || path.startsWith("/api/auth/") || Boolean(auth);
    },
  },
} satisfies NextAuthConfig;
