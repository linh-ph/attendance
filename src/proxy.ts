import { auth } from "@/auth";
import { createProxy, type AuthenticatedProxy } from "@/lib/auth/proxy";

const authenticatedProxy = auth as unknown as AuthenticatedProxy;

export const proxy = createProxy((request) => authenticatedProxy(request));

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
