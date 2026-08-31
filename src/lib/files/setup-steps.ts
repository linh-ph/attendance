/**
 * The setup steps the monthly and legacy flows both run.
 *
 * Everything here is shared tail work: a tab is protected, one unique email at
 * a time is invited, and the stored rows decide the outcome. Whatever created
 * or adopted the tabs, both flows end in `finishSetup`, so `ready` is recorded
 * in exactly one place.
 */

import { STATUS_OPTIONS } from "@/lib/attendance/model";
import type { ConfigStatus, ConfigMember } from "@/lib/config/schema";
import type { DriveFolder, SheetRequest } from "@/lib/google/types";
import {
  MEMBER_INVITE_FAILED_MESSAGE,
  MEMBER_SETUP_STATUSES,
  SetupError,
  type MemberSetupProgress,
  type MemberSetupStatus,
  type MonthlySetupResult,
  type SetupServiceDependencies,
} from "./setup-contracts";


export const DEFAULT_STATUSES: ConfigStatus[] = STATUS_OPTIONS.map((status) => ({
  code: status.code,
  labelEn: status.labelEn,
  sheetValue: status.sheetValue,
}));

export interface PlannedMember {
  displayName: string;
  email: string;
  title: string;
}

export interface EmployeeTab extends PlannedMember {
  sheetId: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toMemberStatus(value: string): MemberSetupStatus {
  return MEMBER_SETUP_STATUSES.includes(value as MemberSetupStatus)
    ? (value as MemberSetupStatus)
    : "pending";
}

export function toProgress(member: ConfigMember): MemberSetupProgress {
  const setupStatus = toMemberStatus(member.setupStatus);

  return {
    displayName: member.displayName,
    email: member.email,
    sheetId: member.sheetId,
    sheetTitle: member.sheetTitle,
    protectionId: member.protectionId,
    permissionId: member.permissionId,
    setupStatus,
    error: setupStatus === "invite-failed" ? MEMBER_INVITE_FAILED_MESSAGE : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface SetupSteps {
  finishSetup(
    fileId: string,
    fileName: string,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    /** False shares the file without letting Drive email anybody about it. */
    notify: boolean,
  ): Promise<MonthlySetupResult>;
}

export function createSetupSteps(dependencies: SetupServiceDependencies): SetupSteps {
  const { drive, config, sheets } = dependencies;

  /** Serialized: Drive does not support concurrent permission changes on a file. */
  async function inviteMembers(
    fileId: string,
    members: readonly MemberSetupProgress[],
    notify: boolean,
  ): Promise<MemberSetupProgress[]> {
    const results: MemberSetupProgress[] = [];

    for (const member of members) {
      if (member.setupStatus === "ready" && member.permissionId !== null) {
        results.push(member);
        continue;
      }

      try {
        const permissionId = await drive.createWriterPermission(fileId, member.email, notify);
        await config.updateMemberProgress(fileId, {
          email: member.email,
          permissionId,
          setupStatus: "ready",
        });
        results.push({ ...member, permissionId, setupStatus: "ready", error: null });
      } catch {
        // The file and every completed member stay intact so this one member
        // can be retried on its own.
        await config.updateMemberProgress(fileId, {
          email: member.email,
          setupStatus: "invite-failed",
        });
        results.push({
          ...member,
          setupStatus: "invite-failed",
          error: MEMBER_INVITE_FAILED_MESSAGE,
        });
      }
    }

    return results;
  }

  /** Shared tail of the fresh and resumed paths: invite, then mark the result. */
  async function finishSetup(
    fileId: string,
    fileName: string,
    folder: DriveFolder,
    planned: readonly PlannedMember[],
    notify: boolean,
  ): Promise<MonthlySetupResult> {
    const { config: stored } = await config.read(fileId);
    const byEmail = new Map(stored.members.map((member) => [member.email, member]));

    const current = planned.map((member) => {
      const found = byEmail.get(member.email);
      if (!found) {
        throw new SetupError(
          "setup-incomplete",
          "The configuration sheet is missing a member added during setup.",
        );
      }
      return toProgress(found);
    });

    const members = await inviteMembers(fileId, current, notify);
    const complete = members.every((member) => member.setupStatus === "ready");

    if (complete) {
      await config.updateSetupState(fileId, "ready");
    }

    return {
      fileId,
      fileName,
      month: stored.month,
      folder,
      setupState: complete ? "ready" : "pending",
      complete,
      members,
    };
  }

  return { finishSetup };
}
