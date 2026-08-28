import { z } from "zod";
import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/session";
import { createGoogleGateways } from "@/lib/google/client";
import { FolderUnavailableError } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const validateFolderRequest = z.object({
  folderId: z.string().trim().min(1).max(256),
});

/**
 * A folder ID returned by Google Picker or restored from browser storage is
 * never trusted until Drive confirms it is an untrashed, owned, writable
 * My Drive folder under the signed-in manager's own OAuth identity.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const parsed = validateFolderRequest.safeParse(await request.json().catch(() => null));

    if (!parsed.success) {
      return Response.json(
        { error: "Select a folder before continuing." },
        { status: 400, headers: NO_STORE },
      );
    }

    const { drive } = createGoogleGateways(session.accessToken);
    const folder = await drive.validateManagerFolder(parsed.data.folderId);

    return Response.json({ folder }, { status: 200, headers: NO_STORE });
  } catch (error) {
    const unauthenticated = toApiErrorResponse(error);
    if (unauthenticated) {
      return unauthenticated;
    }

    if (error instanceof FolderUnavailableError) {
      return Response.json({ error: "Folder unavailable." }, { status: 400, headers: NO_STORE });
    }

    return Response.json(
      { error: "Could not validate the selected folder." },
      { status: 502, headers: NO_STORE },
    );
  }
}
