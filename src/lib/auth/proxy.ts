import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "./paths";

export type AuthenticatedProxy = (
  request: NextRequest,
) => Response | null | undefined | Promise<Response | null | undefined>;

export function createProxy(authenticatedProxy: AuthenticatedProxy) {
  return async (request: NextRequest): Promise<Response> => {
    if (isPublicPath(request.nextUrl.pathname)) {
      return NextResponse.next();
    }

    const response = await authenticatedProxy(request);
    return response instanceof Response
      ? response
      : NextResponse.redirect(new URL("/login", request.url));
  };
}
