const publicPaths = new Set(["/", "/login", "/api/health"]);

/**
 * Files served straight out of `public/` — images, fonts, a manifest.
 *
 * They are world-readable by definition, and the sign-in screen's artwork is
 * fetched before anyone has a session: Next's image optimizer requests the
 * source file over HTTP, so gating it makes the optimizer receive a redirect
 * and answer 400, leaving the login page with a broken image.
 *
 * An API route is never treated as static, whatever its path happens to look
 * like, so a crafted `.json` segment cannot skip the session check.
 */
function isStaticAsset(path: string): boolean {
  if (path.startsWith("/api/")) return false;

  return path.slice(path.lastIndexOf("/") + 1).includes(".");
}

export function isPublicPath(path: string): boolean {
  return publicPaths.has(path) || path.startsWith("/api/auth/") || isStaticAsset(path);
}
