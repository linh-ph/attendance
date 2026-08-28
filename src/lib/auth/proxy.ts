import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "./paths";

export type AuthenticatedProxy = (request: NextRequest) => Response | Promise<Response>;

export function createProxy(authenticatedProxy: AuthenticatedProxy) {
  return (request: NextRequest): Response | Promise<Response> => {
    if (isPublicPath(request.nextUrl.pathname)) {
      return NextResponse.next();
    }

    return authenticatedProxy(request);
  };
}
