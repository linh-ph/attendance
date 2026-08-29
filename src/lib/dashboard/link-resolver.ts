/**
 * Turns a pasted Google Sheets link into a destination inside this app.
 *
 * This is a shortcut, not an access path. It resolves only against the files
 * the dashboard already listed for this signed-in user, and that listing is
 * computed on the server after `authorizeFile`. A link the user has no access
 * to therefore resolves to `no-access` rather than to a route, and the route it
 * does resolve to re-authorizes the request anyway.
 *
 * The `gid` carried by the link is deliberately discarded: an employee is sent
 * to the sheet the configuration maps them to, never to a sheet named in the
 * URL. That keeps a pasted link from addressing a colleague's tab.
 */

import type { ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import { parseSheetLink } from "./sheet-link";

export interface DashboardLists {
  managed: readonly ManagedFile[];
  timesheets: readonly Timesheet[];
}

export type LinkResolution =
  | {
      kind: "timesheet";
      href: string;
      fileId: string;
      /** `null` when no configuration maps this person to a tab. */
      sheetId: string | null;
      name: string;
      sheetTitle: string;
    }
  | { kind: "managed"; href: string; fileId: string; name: string }
  | { kind: "not-a-link" }
  | { kind: "no-access" };

export function resolveSheetLink(input: string, lists: DashboardLists): LinkResolution {
  const link = parseSheetLink(input);
  if (!link) return { kind: "not-a-link" };

  // The employee's own mapped sheet wins: it is the more specific destination
  // when a manager is also a member of their own file.
  const timesheet = lists.timesheets.find((candidate) => candidate.id === link.spreadsheetId);
  if (timesheet) {
    // Without a mapping there is no single tab to open, so the person is taken
    // to the file's tab list to choose their own.
    return {
      kind: "timesheet",
      href:
        timesheet.sheetId === null
          ? `/files/${timesheet.id}/attendance`
          : `/files/${timesheet.id}/attendance/${timesheet.sheetId}`,
      fileId: timesheet.id,
      sheetId: timesheet.sheetId,
      name: timesheet.name,
      sheetTitle: timesheet.sheetTitle ?? "",
    };
  }

  const file = lists.managed.find((candidate) => candidate.id === link.spreadsheetId);
  if (file) {
    return {
      kind: "managed",
      href: `/files/${file.id}/members`,
      fileId: file.id,
      name: file.name,
    };
  }

  return { kind: "no-access" };
}
