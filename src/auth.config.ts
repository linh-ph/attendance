import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { refreshGoogleToken } from "@/lib/auth/google-token";
import { isPublicPath } from "@/lib/auth/paths";
import { GOOGLE_SCOPES } from "@/lib/auth/scopes";
import { toBrowserSession } from "@/lib/auth/session";

// Re-exported so existing importers and tests keep one name for the scope list.
export { GOOGLE_SCOPES };

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
      const email = auth?.user?.email?.trim().toLowerCase();
      return isPublicPath(path) || Boolean(email) && !auth?.error;
    },
  },
} satisfies NextAuthConfig;
