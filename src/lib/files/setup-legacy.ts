/**
 * Setup for an attendance file this application did not create.
 *
 * The legacy-file guard (section 7.3 plus section 5.3): Drive metadata
 * discovery alone never authorizes a mutation on such a file, so every entry
 * point re-derives the role from current ownership and re-proves the file is
 * still a direct child of the manager's active folder under that manager's own
 * identity. The Drive name wins over anything the browser sent.
 *
 * The tabs themselves are only ever read and protected — never templated —
 * because the workbook already holds attendance rows.
 */

import { ForbiddenError, authorizeFile } from "@/lib/access/policy";
import {
  APP_PROPERTY_MONTH,
  ConfigMissingError,
  isConfigRepositoryError,
  type ConfigReadResult,
} from "@/lib/config/repository";
import {
  CONFIG_SHEET_TITLE,
  isAppConfigError,
  normalizeEmail,
} from "@/lib/config/schema";
import {
  ATTENDANCE_NAME_MARKER,
  type DriveFolder,
  type SpreadsheetSnapshot,
} from "@/lib/google/types";
import { TEMPLATE_VERSION } from "@/lib/workbook/template";
import {
  LegacySetupError,
  type ConfigureExistingFileInput,
  type ExistingFileInspection,
  type ExistingSheetMapping,
  type InspectExistingFileInput,
  type MonthlySetupResult,
  type SetupServiceDependencies,
} from "./setup-contracts";
import {
  DEFAULT_STATUSES,
  toProgress,
  type EmployeeTab,
  type SetupSteps,
} from "./setup-steps";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A mapping after normalization, before it is matched to a live tab. */
interface MappedMember {
  displayName: string;
  email: string;
  sheetId: string;
}

/**
 * Rejects an ambiguous mapping table before any Google call, so a rejected
 * request never configures, shares, or protects anything.
 */
function planExistingMappings(mappings: readonly ExistingSheetMapping[]): MappedMember[] {
  const seenEmails = new Set<string>();
  const seenSheetIds = new Set<string>();

  return mappings.map((mapping) => {
    const email = normalizeEmail(mapping.email);
    const sheetId = mapping.sheetId.trim();

    if (seenEmails.has(email)) {
      throw new LegacySetupError(
        "duplicate-member-email",
        `Member email "${email}" is listed more than once.`,
      );
    }
    if (seenSheetIds.has(sheetId)) {
      throw new LegacySetupError(
        "duplicate-sheet-mapping",
        "Assign each sheet in this file to exactly one member.",
      );
    }

    seenEmails.add(email);
    seenSheetIds.add(sheetId);

    return { displayName: mapping.displayName.trim(), email, sheetId };
  });
}

function employeeSheets(snapshot: SpreadsheetSnapshot): SpreadsheetSnapshot["sheets"] {
  return snapshot.sheets.filter((sheet) => sheet.title !== CONFIG_SHEET_TITLE);
}

/**
 * Resolves every mapping onto a tab that exists right now, and requires the
 * mapping table to cover every managed employee sheet. The stored title is
 * always the live one: a tab is identified by its numeric ID, never by a name
 * the browser sent.
 */
function resolveExistingTabs(
  snapshot: SpreadsheetSnapshot,
  mapped: readonly MappedMember[],
): EmployeeTab[] {
  const sheets = employeeSheets(snapshot);

  const tabs = mapped.map((member) => {
    const sheet = sheets.find((candidate) => String(candidate.sheetId) === member.sheetId);
    if (!sheet) {
      throw new LegacySetupError(
        "member-sheet-missing",
        `The sheet mapped to "${member.email}" is missing from this file.`,
      );
    }

    return {
      displayName: member.displayName === "" ? sheet.title : member.displayName,
      email: member.email,
      title: sheet.title,
      sheetId: sheet.sheetId,
    };
  });

  const mappedSheetIds = new Set(tabs.map((tab) => tab.sheetId));
  const unmapped = sheets.find((sheet) => !mappedSheetIds.has(sheet.sheetId));

  if (unmapped) {
    throw new LegacySetupError(
      "unmapped-employee-sheet",
      `Sheet "${unmapped.title}" has no employee assigned to it.`,
    );
  }

  return tabs;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface LegacySetup {
  inspectExisting(input: InspectExistingFileInput): Promise<ExistingFileInspection>;
  configureExisting(input: ConfigureExistingFileInput): Promise<MonthlySetupResult>;
}

export function createLegacySetup(
  dependencies: SetupServiceDependencies,
  steps: SetupSteps,
): LegacySetup {
  const { drive, sheets, config } = dependencies;
  const { finishSetup } = steps;

  /**
   * The legacy-file guard (section 7.3 plus section 5.3).
   *
   * Drive metadata discovery alone never authorizes a mutation on a legacy
   * file, so every entry point re-derives the role from current ownership and
   * re-proves the file is still a direct child of the manager's active folder
   * under that manager's own identity. The Drive name wins over anything the
   * browser sent.
   */
  async function requireLegacyManagerFile(
    ownerEmail: string,
    fileId: string,
    folderId: string,
  ): Promise<{ folder: DriveFolder; fileName: string; driveMonth: string | null }> {
    const role = await authorizeFile({ drive }, { fileId, actorEmail: ownerEmail });
    if (role.kind !== "manager") {
      throw new ForbiddenError("actor-not-owner");
    }

    const folder = await drive.validateManagerFolder(folderId);
    const file = (await drive.listManagerFiles(folder.id)).find(
      (candidate) => candidate.id === fileId,
    );

    if (!file || !file.ownedByMe) {
      throw new ForbiddenError("file-not-in-folder");
    }

    if (!file.name.includes(ATTENDANCE_NAME_MARKER)) {
      throw new LegacySetupError(
        "file-not-supported",
        "This file is not an attendance file. Rename it before setting it up.",
      );
    }

    const driveMonth = file.appProperties[APP_PROPERTY_MONTH];

    return {
      folder,
      fileName: file.name,
      driveMonth: driveMonth === undefined || driveMonth === "" ? null : driveMonth,
    };
  }

  /**
   * The configuration this app can actually trust, or `null`.
   *
   * A missing, broken, or foreign `__APP_CONFIG` all resolve to `null`: setup
   * replaces such a sheet rather than reading anything out of it.
   */
  async function readTrustedConfig(fileId: string): Promise<ConfigReadResult | null> {
    try {
      return await config.read(fileId);
    } catch (error) {
      if (
        error instanceof ConfigMissingError ||
        isConfigRepositoryError(error) ||
        isAppConfigError(error)
      ) {
        return null;
      }
      throw error;
    }
  }

  /** First attempt: write the current schema over whatever config sheet exists. */
  async function initializeExistingFile(
    fileId: string,
    month: string,
    ownerEmail: string,
    tabs: readonly EmployeeTab[],
  ): Promise<void> {
    await config.initialize({
      fileId,
      month,
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
      // An `__APP_CONFIG` this app did not write is never trusted, only replaced.
      replaceExisting: true,
    });
  }

  /**
   * Retry: the stored rows own the progress, so a completed protection or
   * invitation is never repeated and no tab is touched.
   */
  async function resumeExistingFile(
    fileId: string,
    ownerEmail: string,
    tabs: readonly EmployeeTab[],
    stored: ConfigReadResult,
  ): Promise<void> {
    const byEmail = new Map(stored.config.members.map((member) => [member.email, member]));

    // Checked before any write: re-pointing a member would orphan the
    // protection recorded for their previous tab.
    for (const tab of tabs) {
      const member = byEmail.get(tab.email);
      if (member && member.sheetId !== null && member.sheetId !== String(tab.sheetId)) {
        throw new LegacySetupError(
          "mapping-conflict",
          `This file already maps "${tab.email}" to a different sheet. It needs repair.`,
        );
      }
    }

    for (const tab of tabs) {
      const member = byEmail.get(tab.email);
      if (member && member.sheetId !== null) continue;

      await config.updateMemberProgress(fileId, {
        email: tab.email,
        displayName: tab.displayName,
        sheetId: String(tab.sheetId),
        sheetTitle: tab.title,
        setupStatus: "pending",
      });
    }

  }

  return {
    async inspectExisting(input: InspectExistingFileInput): Promise<ExistingFileInspection> {
      const ownerEmail = normalizeEmail(input.ownerEmail);
      const { folder, fileName, driveMonth } = await requireLegacyManagerFile(
        ownerEmail,
        input.fileId,
        input.folderId,
      );

      const snapshot = await sheets.getSpreadsheet(input.fileId);
      const stored = await readTrustedConfig(input.fileId);
      const hasConfigSheet = snapshot.sheets.some((sheet) => sheet.title === CONFIG_SHEET_TITLE);

      return {
        fileId: input.fileId,
        fileName,
        folder,
        month: stored?.config.month ?? driveMonth,
        sheets: employeeSheets(snapshot).map((sheet) => ({
          sheetId: String(sheet.sheetId),
          title: sheet.title,
        })),
        hasUntrustedConfig: hasConfigSheet && stored === null,
        members: stored === null ? [] : stored.config.members.map(toProgress),
      };
    },

    async configureExisting(input: ConfigureExistingFileInput): Promise<MonthlySetupResult> {
      const ownerEmail = normalizeEmail(input.ownerEmail);

      // Pure validation first: an ambiguous mapping table never reaches Google.
      const mapped = planExistingMappings(input.mappings);

      const { folder, fileName } = await requireLegacyManagerFile(
        ownerEmail,
        input.fileId,
        input.folderId,
      );

      // The tabs are only ever read and protected here. `buildEmployeeSheetPlan`
      // is deliberately absent: its grid resize would truncate the attendance
      // rows this file already holds.
      const snapshot = await sheets.getSpreadsheet(input.fileId);
      const tabs = resolveExistingTabs(snapshot, mapped);

      const stored = await readTrustedConfig(input.fileId);

      if (stored === null) {
        await initializeExistingFile(input.fileId, input.month, ownerEmail, tabs);
      } else {
        await resumeExistingFile(input.fileId, ownerEmail, tabs, stored);
      }

      // Adopting an existing workbook always announces itself.
      return await finishSetup(input.fileId, fileName, folder, tabs, true);
    },
  };
}
