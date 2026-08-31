/**
 * Add-member management for an already configured monthly file.
 *
 * Section 4.4 of the approved design: a manager may add one name/email after
 * the file exists. The operation creates one employee tab from the file's own
 * template, records the mapping, applies protection, and shares the file. It
 * never removes a mapping and never revokes Drive access — that is a separate
 * destructive flow and is deliberately absent here.
 *
 * Authorization follows section 7.3: the actor is the verified session email,
 * the role comes from current Drive ownership plus the protected mapping, and
 * a client-supplied owner is never used. Only the current owner may list or
 * add members; a mapped employee of the same file is refused like any other
 * signed-in stranger, before any mutation.
 *
 * Progress invariant (section 9.2): the tab, its template, and its protection
 * are created first and recorded in one member row; the Drive invitation is
 * the last step and is serialized, because Drive does not support concurrent
 * permission changes on one file. A failed invitation keeps the tab and the
 * recorded IDs and is retried alone — `retryInvitation` never re-creates the
 * tab, and therefore never replays `buildEmployeeSheetPlan`, whose grid shrink
 * is safe only on a freshly added tab.
 */

import { ForbiddenError, authorizeFile, NeedsRepairError, NeedsSetupError } from "@/lib/access/policy";
import {
  ConfigMissingError,
  isConfigRepositoryError,
  type ConfigReadResult,
  type ConfigRepository,
} from "@/lib/config/repository";
import {
  isAppConfigError,
  normalizeEmail,
  type ConfigMember,
  type ConfigStatus,
} from "@/lib/config/schema";
import type { DriveGateway, SheetRequest, SheetsGateway } from "@/lib/google/types";
import {
  TEMPLATE_VERSION,
  buildEmployeeSheetPlan,
  buildEmployeeSheetTitle,
  isSheetTitleError,
  normalizeSheetTitleKey,
} from "@/lib/workbook/template";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type MemberErrorCode =
  | "invalid-member"
  | "member-exists"
  | "sheet-title-conflict"
  | "member-not-found"
  | "template-version-unsupported"
  | "member-setup-incomplete";

export class MemberServiceError extends Error {
  readonly code: MemberErrorCode;

  constructor(code: MemberErrorCode, message: string) {
    super(message);
    this.name = "MemberServiceError";
    this.code = code;
  }
}

export function isMemberServiceError(value: unknown): value is MemberServiceError {
  return value instanceof MemberServiceError;
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export const MEMBER_SETUP_STATUSES = ["pending", "ready", "invite-failed"] as const;
export type MemberSetupStatus = (typeof MEMBER_SETUP_STATUSES)[number];

/** One member as the manager sees it. Never carries provider detail. */
export interface MemberSummary {
  displayName: string;
  email: string;
  /** Numeric Google sheet ID stored as a string; `null` until the tab exists. */
  sheetId: string | null;
  sheetTitle: string | null;
  setupStatus: MemberSetupStatus;
  /** True once Drive holds a writer permission for this member. */
  invitationSent: boolean;
}

export interface MemberListResult {
  fileId: string;
  /** `YYYY-MM`, taken from the protected configuration. */
  month: string;
  members: MemberSummary[];
}

export interface MemberMutationResult {
  fileId: string;
  member: MemberSummary;
  /** The tab and mapping exist, but Drive would not share the file. */
  invitationFailed: boolean;
}

export interface ListMembersInput {
  fileId: string;
  /** Normalized verified session email. Never a client-supplied value. */
  actorEmail: string;
}

export interface AddMemberInput extends ListMembersInput {
  displayName: string;
  email: string;
}

export interface RetryInvitationInput extends ListMembersInput {
  email: string;
}

export interface MemberServiceDependencies {
  drive: DriveGateway;
  sheets: SheetsGateway;
  config: ConfigRepository;
}

export interface MemberService {
  listMembers(input: ListMembersInput): Promise<MemberListResult>;
  addMember(input: AddMemberInput): Promise<MemberMutationResult>;
  retryInvitation(input: RetryInvitationInput): Promise<MemberMutationResult>;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

const NAME_REQUIRED = "Enter the member's name.";
const EMAIL_INVALID = "Enter a valid Google Workspace email address.";
const MEMBER_EXISTS = "This email is already a member of this file.";
const TITLE_CONFLICT = "This file already has a sheet with that name.";
const MEMBER_NOT_FOUND = "This email is not a member of this file.";
const TEMPLATE_UNSUPPORTED =
  "This file was built by a different version of the attendance template.";


/** Same shape the configuration parser accepts, so a stored row round-trips. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The create flow writes `complete`; both words mean "fully set up". */
const READY_STATUSES = new Set(["ready"]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toSetupStatus(stored: string): MemberSetupStatus {
  const value = stored.trim().toLowerCase();
  if (READY_STATUSES.has(value)) return "ready";
  if (value === "invite-failed") return "invite-failed";
  return "pending";
}

function toSummary(member: ConfigMember): MemberSummary {
  return {
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    setupStatus: toSetupStatus(member.setupStatus),
    invitationSent: member.permissionId !== null,
  };
}

/**
 * Validates the requested tab name on its own. A title that collides with an
 * existing tab is a conflict, not a malformed request; anything else (empty,
 * too long, illegal character) is a bad request.
 */
function buildRequestedTitle(displayName: string): string {
  try {
    return buildEmployeeSheetTitle(displayName);
  } catch (error) {
    if (isSheetTitleError(error)) {
      const code = error.code === "reserved-title" ? "sheet-title-conflict" : "invalid-member";
      throw new MemberServiceError(code, error.message);
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createMemberService(dependencies: MemberServiceDependencies): MemberService {
  const { drive, sheets, config } = dependencies;

  /** Only the file's current Drive owner may see or change the roster. */
  async function requireManager(fileId: string, actorEmail: string): Promise<string> {
    const role = await authorizeFile({ drive, config }, { fileId, actorEmail });

    if (role.kind !== "manager") {
      throw new ForbiddenError("actor-not-owner");
    }

    return role.email;
  }

  /** An unreadable configuration is `Needs setup`/`Needs repair`, never a fallback. */
  async function readConfig(fileId: string): Promise<ConfigReadResult> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        throw new NeedsSetupError("config-sheet-missing");
      }
      if (isConfigRepositoryError(error)) {
        throw new NeedsRepairError(`config-repository:${error.code}`);
      }
      if (isAppConfigError(error)) {
        throw new NeedsRepairError(`config-unreadable:${error.code}`);
      }
      throw error;
    }
  }

  async function createEmployeeTab(fileId: string, title: string): Promise<number> {
    const { replies } = await sheets.batchUpdate(fileId, [
      { addSheet: { properties: { title } } },
    ]);
    const added = replies.find((reply) => reply.addSheet !== undefined)?.addSheet;

    if (!added) {
      throw new MemberServiceError(
        "member-setup-incomplete",
        "Google did not return the created employee sheet.",
      );
    }

    return added.sheetId;
  }

  /** Only ever applied to the tab created in this request. */
  async function applyTemplate(
    fileId: string,
    sheetId: number,
    month: string,
    statuses: readonly ConfigStatus[],
  ): Promise<void> {
    const plan = buildEmployeeSheetPlan({ sheetId, month, statuses });
    await sheets.batchUpdate(fileId, [...plan.requests]);
  }

  /**
   * The last step of both add and retry. Only the Drive call is guarded, so a
   * failure to record progress is never mistaken for a failed invitation.
   */
  async function inviteMember(fileId: string, email: string): Promise<MemberMutationResult> {
    let permissionId: string | null = null;

    try {
      permissionId = await drive.createWriterPermission(fileId, email);
    } catch {
      // The tab, the mapping, and the protection stay intact so this one
      // member can be retried on their own.
      permissionId = null;
    }

    const stored =
      permissionId === null
        ? await config.updateMemberProgress(fileId, { email, setupStatus: "invite-failed" })
        : await config.updateMemberProgress(fileId, {
            email,
            permissionId,
            setupStatus: "ready",
          });

    return { fileId, member: toSummary(stored), invitationFailed: permissionId === null };
  }

  return {
    async listMembers(input: ListMembersInput): Promise<MemberListResult> {
      await requireManager(input.fileId, input.actorEmail);
      const { config: stored } = await readConfig(input.fileId);

      return {
        fileId: input.fileId,
        month: stored.month,
        members: stored.members.map(toSummary),
      };
    },

    async addMember(input: AddMemberInput): Promise<MemberMutationResult> {
      // Boundary validation first: a rejected request must never reach Google.
      const displayName = input.displayName.trim();
      const email = normalizeEmail(input.email);

      if (displayName === "") {
        throw new MemberServiceError("invalid-member", NAME_REQUIRED);
      }
      if (!EMAIL_PATTERN.test(email)) {
        throw new MemberServiceError("invalid-member", EMAIL_INVALID);
      }

      const ownerEmail = await requireManager(input.fileId, input.actorEmail);
      const { config: stored, spreadsheet } = await readConfig(input.fileId);

      // The new tab is generated by the same template that produced this file.
      if (stored.templateVersion !== TEMPLATE_VERSION) {
        throw new MemberServiceError("template-version-unsupported", TEMPLATE_UNSUPPORTED);
      }

      if (stored.members.some((member) => member.email === email)) {
        throw new MemberServiceError("member-exists", MEMBER_EXISTS);
      }

      const title = buildRequestedTitle(displayName);
      const takenTitles = new Set([
        ...spreadsheet.sheets.map((sheet) => normalizeSheetTitleKey(sheet.title)),
        ...stored.members.flatMap((member) =>
          member.sheetTitle === null ? [] : [normalizeSheetTitleKey(member.sheetTitle)],
        ),
      ]);

      if (takenTitles.has(normalizeSheetTitleKey(title))) {
        throw new MemberServiceError("sheet-title-conflict", TITLE_CONFLICT);
      }

      const sheetId = await createEmployeeTab(input.fileId, title);
      await applyTemplate(input.fileId, sheetId, stored.month, stored.statuses);

      // One write: a member row is only meaningful once its tab is templated,
      // so a resume never replays the template onto it. The tab itself is left
      // open — see `docs/decisions/2026-08-29-app-is-a-sheets-client.md`.
      await config.updateMemberProgress(input.fileId, {
        email,
        displayName,
        sheetId: String(sheetId),
        sheetTitle: title,
        setupStatus: "pending",
      });

      return await inviteMember(input.fileId, email);
    },

    async retryInvitation(input: RetryInvitationInput): Promise<MemberMutationResult> {
      await requireManager(input.fileId, input.actorEmail);

      const email = normalizeEmail(input.email);
      const { config: stored } = await readConfig(input.fileId);
      const member = stored.members.find((candidate) => candidate.email === email);

      if (!member) {
        throw new MemberServiceError("member-not-found", MEMBER_NOT_FOUND);
      }

      // Drive already holds a writer permission: a second one would be a
      // duplicate share, not a repair.
      if (member.permissionId !== null) {
        return { fileId: input.fileId, member: toSummary(member), invitationFailed: false };
      }

      return await inviteMember(input.fileId, email);
    },
  };
}
