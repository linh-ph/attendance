/**
 * The Google access this application asks for, in one place.
 *
 * It lives apart from `auth.config.ts` because the Supabase sign-in button is a
 * client component: importing the Auth.js config there would pull the whole
 * provider — and a `clientSecret` expression — into the browser bundle. Next
 * would replace the secret with `undefined` rather than leak it, but shipping
 * the reference at all is not worth a shared constant.
 *
 * Both sign-in paths read this list, so they cannot drift into requesting
 * different Drive access.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;
