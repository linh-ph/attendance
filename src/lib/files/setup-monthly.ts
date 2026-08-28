/**
 * The create flow of section 8.1 of the approved design:
 *
 * 1. revalidate the destination folder immediately before Drive creation;
 * 2. create the spreadsheet under the manager's own OAuth identity;
 * 3. record `pending` so a half-configured file is still discoverable;
 * 4. create the employee tabs and the protected `__APP_CONFIG` tab;
 * 5. add protections;
 * 6. invite one unique employee email at a time — Drive does not support
 *    concurrent permission changes on one file;
 * 7. keep individual invitation failures next to their member;
 * 8. mark `ready` only when every step succeeded.
 *
 * A created file is never deleted as rollback (section 9.2). A failed attempt
 * returns the file ID, the revalidated folder, and per-member progress so the
 * browser can resume with `resumeFileId`.
 *
 * Progress invariant: a member row carries a `sheetId` only once that tab has
 * been created *and* templated. `buildEmployeeSheetPlan` shrinks the grid to the
 * month's row count, which is safe on a fresh tab and destructive on a populated
 * one, so a resume never replays the template onto an existing tab.
 */

import {
  ConfigMissingError,
  buildAppProperties,
  type ConfigReadResult,
} from "@/lib/config/repository";
import { normalizeEmail, type ConfigStatus } from "@/lib/config/schema";
import type {
  DriveFolder,
  SheetRequest,
  SpreadsheetSnapshot,
} from "@/lib/google/types";
import {
  TEMPLATE_VERSION,
  buildEmployeeSheetPlan,
  buildEmployeeSheetTitles,
} from "@/lib/workbook/template";
import type { CreateFileInput, CreateFileMemberInput } from "./schemas";
import {
  SetupError,
  type CreateMonthlyFileInput,
  type MonthlySetupResult,
  type SetupServiceDependencies,
} from "./setup-contracts";
import {
  DEFAULT_STATUSES,
  type EmployeeTab,
  type PlannedMember,
  type SetupSteps,
} from "./setup-steps";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rejects duplicate identities before any Google call so a rejected request
 * never leaves a half-created file behind.
 */
function planMembers(members: readonly CreateFileMemberInput[]): PlannedMember[] {
  const seen = new Set<string>();

  const normalized = members.map((member) => {
    const email = normalizeEmail(member.email);
    if (seen.has(email)) {
      throw new SetupError(
        "duplicate-member-email",
        `Member email "${email}" is listed more than once.`,
      );
    }

    seen.add(email);
    return { displayName: member.displayName.trim(), email };
  });

  // Throws SheetTitleError for empty, reserved, illegal, or duplicate tab names.
  const titles = buildEmployeeSheetTitles(normalized.map((member) => member.displayName));

  return normalized.map((member, index) => ({ ...member, title: titles[index] }));
}

function hasSheet(snapshot: SpreadsheetSnapshot, sheetId: string): boolean {
  return snapshot.sheets.some((sheet) => String(sheet.sheetId) === sheetId);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface MonthlySetup {
  create(input: CreateMonthlyFileInput): Promise<MonthlySetupResult>;
}

export function createMonthlySetup(
  dependencies: SetupServiceDependencies,
  steps: SetupSteps,
): MonthlySetup {
  const { drive, sheets, config } = dependencies;
  const { protectEmployeeTabs, finishSetup } = steps;

  /**
   * Adds one tab per member and removes the tabs Drive created with the file,
   * in a single batch so the workbook is never left without a sheet.
   */
  async function createEmployeeTabs(
    fileId: string,
    members: readonly PlannedMember[],
    removeSheetIds: readonly number[],
  ): Promise<EmployeeTab[]> {
    const requests: SheetRequest[] = [
      ...members.map((member) => ({ addSheet: { properties: { title: member.title } } })),
      ...removeSheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })),
    ];

    const { replies } = await sheets.batchUpdate(fileId, requests);
    const added = replies.flatMap((reply) => (reply.addSheet ? [reply.addSheet] : []));

    if (added.length !== members.length) {
      throw new SetupError(
        "setup-incomplete",
        "Google did not return every created employee sheet.",
      );
    }

    return members.map((member, index) => ({ ...member, sheetId: added[index].sheetId }));
  }

  /** Only ever applied to tabs created in this request. */
  async function applyEmployeeTemplates(
    fileId: string,
    tabs: readonly EmployeeTab[],
    month: string,
    statuses: readonly ConfigStatus[],
  ): Promise<void> {
    const requests = tabs.flatMap((tab) => [
      ...buildEmployeeSheetPlan({ sheetId: tab.sheetId, month, statuses }).requests,
    ]);

    if (requests.length > 0) {
      await sheets.batchUpdate(fileId, requests);
    }
  }

  async function buildNewFile(
    ownerEmail: string,
    request: CreateFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
  ): Promise<MonthlySetupResult> {
    const file = await drive.createSpreadsheetFile({ name: request.fileName, folderId: folder.id });

    // Recorded before any sheet work so a failure below still leaves a file the
    // dashboard can find and resume.
    await drive.updateAppProperties(file.id, buildAppProperties(request.month, "pending"));

    const initial = await sheets.getSpreadsheet(file.id);
    const tabs = await createEmployeeTabs(
      file.id,
      planned,
      initial.sheets.map((sheet) => sheet.sheetId),
    );
    await applyEmployeeTemplates(file.id, tabs, request.month, DEFAULT_STATUSES);

    await config.initialize({
      fileId: file.id,
      month: request.month,
      ownerEmail,
      templateVersion: TEMPLATE_VERSION,
      statuses: DEFAULT_STATUSES,
      members: tabs.map((tab) => ({
        displayName: tab.displayName,
        email: tab.email,
        sheetId: String(tab.sheetId),
        sheetTitle: tab.title,
        protectionId: null,
        permissionId: null,
        setupStatus: "pending",
      })),
    });

    await protectEmployeeTabs(file.id, tabs, ownerEmail);

    return await finishSetup(file.id, file.name, folder, planned);
  }

  async function readResumableConfig(fileId: string): Promise<ConfigReadResult> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        throw new SetupError(
          "resume-unavailable",
          "This file has no attendance configuration to resume. Run setup for it instead.",
        );
      }
      throw error;
    }
  }

  async function resumeFile(
    ownerEmail: string,
    request: CreateFileInput,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    fileId: string,
  ): Promise<MonthlySetupResult> {
    const existing = await readResumableConfig(fileId);
    const byEmail = new Map(existing.config.members.map((member) => [member.email, member]));

    // A recorded tab that no longer exists is a repair case, never a silent
    // rebuild: recreating it would discard whatever the member already saved.
    for (const member of existing.config.members) {
      if (member.sheetId !== null && !hasSheet(existing.spreadsheet, member.sheetId)) {
        throw new SetupError(
          "member-sheet-missing",
          "A configured employee sheet is missing from this file. It needs repair.",
        );
      }
    }

    // Only members without a completed tab are created; an existing tab is
    // reconciled by leaving it exactly as it is.
    const missingTabs = planned.filter((member) => {
      const stored = byEmail.get(member.email);
      return stored === undefined || stored.sheetId === null;
    });

    const createdTabs =
      missingTabs.length === 0
        ? []
        : await createEmployeeTabs(fileId, missingTabs, []);

    if (createdTabs.length > 0) {
      await applyEmployeeTemplates(fileId, createdTabs, existing.config.month, existing.config.statuses);

      for (const tab of createdTabs) {
        await config.updateMemberProgress(fileId, {
          email: tab.email,
          displayName: tab.displayName,
          sheetId: String(tab.sheetId),
          sheetTitle: tab.title,
          setupStatus: "pending",
        });
      }
    }

    const unprotected = planned.flatMap((member) => {
      const created = createdTabs.find((tab) => tab.email === member.email);
      if (created) return [created];

      const stored = byEmail.get(member.email);
      if (!stored || stored.sheetId === null || stored.protectionId !== null) return [];

      return [{ ...member, sheetId: Number(stored.sheetId) }];
    });

    await protectEmployeeTabs(fileId, unprotected, ownerEmail);

    return await finishSetup(fileId, request.fileName, folder, planned);
  }

  return {
    async create(input: CreateMonthlyFileInput): Promise<MonthlySetupResult> {
      const ownerEmail = normalizeEmail(input.ownerEmail);
      const planned = planMembers(input.request.members);

      // Revalidated under the manager's own identity immediately before any
      // mutation, so a folder that became unavailable rejects the request.
      const folder = await drive.validateManagerFolder(input.request.destinationFolder.id);

      return input.resumeFileId === undefined
        ? await buildNewFile(ownerEmail, input.request, folder, planned)
        : await resumeFile(ownerEmail, input.request, folder, planned, input.resumeFileId);
    },
  };
}
