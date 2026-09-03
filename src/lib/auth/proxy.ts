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
    if (response instanceof Response) {
      return response;
    }

    /*
     * `no-store` is not decoration. A redirect to `/login` is only true for as
     * long as the person is signed out, and a browser that caches it replays it
     * after they sign in — sending them back to the login page from a session
     * that is perfectly valid, without ever asking the server. That was
     * observed here, and it is indistinguishable from a broken sign-in.
     */
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    redirect.headers.set("Cache-Control", "no-store");
    return redirect;
  };
}
