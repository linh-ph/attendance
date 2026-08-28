import { z } from "zod";
import { isAccessError, type AccessErrorCode } from "@/lib/access/policy";
import { requireGoogleSessionFromRequest, toApiErrorResponse } from "@/lib/auth/session";
import { createConfigRepository } from "@/lib/config/repository";
import {
  createMemberService,
  isMemberServiceError,
  type MemberErrorCode,
  type MemberMutationResult,
  type MemberService,
} from "@/lib/files/member-service";
import { createGoogleGateways } from "@/lib/google/client";
import { FileUnavailableError } from "@/lib/google/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Removing a member and revoking Drive access are a separate destructive flow
 * (section 2.1) and are deliberately absent: this route exposes no `DELETE`
 * and no `PUT`.
 */

/* -------------------------------------------------------------------------- */
/* Boundary validation                                                         */
/* -------------------------------------------------------------------------- */

/** Emails are normalized to lowercase before they reach the service. */
const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email());

/**
 * Only the member's own identity is accepted. The file ID comes from the route
 * and the owner from the verified session, so a `fileId`, `actorEmail`, or
 * `setupStatus` in the body is stripped here and can never reach Google.
 */
const addMemberSchema = z.object({
  displayName: z.string().trim().min(1),
  email: emailSchema,
});

const retryInvitationSchema = z.object({ email: emailSchema });

/* -------------------------------------------------------------------------- */
/* Error mapping                                                               */
/* -------------------------------------------------------------------------- */

const ACCESS_ERROR_STATUS: Record<AccessErrorCode, number> = {
  forbidden: 403,
  "needs-setup": 409,
  "needs-repair": 409,
};

const MEMBER_ERROR_STATUS: Record<MemberErrorCode, number> = {
  "invalid-member": 400,
  "member-exists": 409,
  "sheet-title-conflict": 409,
  "member-not-found": 404,
  "template-version-unsupported": 409,
  "member-setup-incomplete": 502,
};

function errorJson(message: string, status: number, code?: string): Response {
  return Response.json(
    code === undefined ? { error: message } : { error: message, code },
    { status, headers: NO_STORE },
  );
}

function toErrorResponse(error: unknown): Response {
  const unauthenticated = toApiErrorResponse(error);
  if (unauthenticated) return unauthenticated;

  if (isAccessError(error)) {
    return errorJson(error.message, ACCESS_ERROR_STATUS[error.code], error.code);
  }

  if (isMemberServiceError(error)) {
    return errorJson(error.message, MEMBER_ERROR_STATUS[error.code], error.code);
  }

  if (error instanceof FileUnavailableError) {
    return errorJson(error.message, 404, error.code);
  }

  return errorJson("Could not update the members of this attendance file.", 502);
}

function mutationResponse(result: MemberMutationResult, createdStatus: number): Response {
  return Response.json(
    { member: result.member, invitationFailed: result.invitationFailed },
    // A retained tab with a failed invitation is a partial success, not a
    // failure: the IDs are returned so the browser can retry that one member.
    { status: result.invitationFailed ? 207 : createdStatus, headers: NO_STORE },
  );
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export interface MemberRouteDependencies {
  /** Builds a service bound to the caller's own Google OAuth identity. */
  createService(accessToken: string): Promise<MemberService>;
}

const defaultDependencies: MemberRouteDependencies = {
  async createService(accessToken: string): Promise<MemberService> {
    const { drive, sheets } = createGoogleGateways(accessToken);
    return createMemberService({ drive, sheets, config: createConfigRepository({ sheets, drive }) });
  },
};

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/files/[fileId]/members`
 *
 * Lists the roster and each member's setup status from the protected
 * configuration. Only the file's current Drive owner is answered.
 */
export async function GET(
  request: Request,
  context: RouteContext,
  dependencies: MemberRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId } = await context.params;
    const service = await dependencies.createService(session.accessToken);

    const result = await service.listMembers({ fileId, actorEmail: session.email });

    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `POST /api/files/[fileId]/members`
 *
 * Adds one member: a new employee tab from the file's own month and template,
 * the mapping, its protection, and the Drive invitation. Authentication runs
 * before the body is read, and validation before any Google call.
 */
export async function POST(
  request: Request,
  context: RouteContext,
  dependencies: MemberRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId } = await context.params;

    const parsed = addMemberSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return errorJson(
        "Enter the member's name and a valid Google Workspace email address.",
        400,
        "invalid-member",
      );
    }

    const service = await dependencies.createService(session.accessToken);
    const result = await service.addMember({
      fileId,
      actorEmail: session.email,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
    });

    return mutationResponse(result, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `PATCH /api/files/[fileId]/members`
 *
 * Retries the Drive invitation for exactly one existing member. The tab, the
 * mapping, and the protection are never re-created.
 */
export async function PATCH(
  request: Request,
  context: RouteContext,
  dependencies: MemberRouteDependencies = defaultDependencies,
): Promise<Response> {
  try {
    const session = await requireGoogleSessionFromRequest(request);
    const { fileId } = await context.params;

    const parsed = retryInvitationSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return errorJson("Send the email address of the member to invite again.", 400, "invalid-member");
    }

    const service = await dependencies.createService(session.accessToken);
    const result = await service.retryInvitation({
      fileId,
      actorEmail: session.email,
      email: parsed.data.email,
    });

    return mutationResponse(result, 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}
