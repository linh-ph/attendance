import { auth } from "@/auth";
import { createProxy, type AuthenticatedProxy } from "@/lib/auth/proxy";
import { NextResponse } from "next/server";

const authenticatedProxy = auth(() => NextResponse.next());

export const proxy = createProxy(authenticatedProxy as unknown as AuthenticatedProxy);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
