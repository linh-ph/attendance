const publicPaths = new Set(["/", "/login", "/api/health"]);

export function isPublicPath(path: string): boolean {
  return publicPaths.has(path) || path.startsWith("/api/auth/");
}
