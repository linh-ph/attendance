import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/google-session";

export const dynamic = "force-dynamic";

/**
 * Hands the browser the short-lived Google access token for one Picker session.
 * The refresh token and the client secret never leave the server.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { accessToken } = await requireGoogleSessionFromRequest(request);

    return Response.json(
      { accessToken },
      { status: 200, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return (
      toApiErrorResponse(error) ??
      Response.json(
        { error: "Could not start Google Picker." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      )
    );
  }
}
