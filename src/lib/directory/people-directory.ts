import { normalizeEmail } from "@/lib/config/schema";
import type { DriveGateway } from "@/lib/google/types";

/**
 * The colleagues this account can already see, read from Drive's own sharing
 * lists rather than from a directory API.
 *
 * Listing a Workspace needs the Admin SDK and an administrator; this app has
 * neither. What it does have is `permissions.list` on every attendance file the
 * signed-in user can already open, and the people on those files are exactly
 * the people a roster is built from. Nothing here reaches past what Google has
 * already decided this account may see.
 *
 * The result is a suggestion list, never an authority: it is offered when
 * filling in a roster, and the browser keeps whatever the person chooses.
 */

export interface DirectoryPerson {
  email: string;
  displayName: string | null;
  /** How many reachable attendance files grant this person access. */
  fileCount: number;
}

export interface PeopleDirectory {
  load(actorEmail: string): Promise<DirectoryPerson[]>;
}

export function createPeopleDirectory(drive: DriveGateway): PeopleDirectory {
  return {
    async load(actorEmail) {
      const actor = normalizeEmail(actorEmail);
      const files = await drive.listEmployeeCandidates();
      const found = new Map<string, DirectoryPerson>();

      for (const file of files) {
        let people;
        try {
          people = await drive.listPeople(file.id);
        } catch {
          // A file can be openable while its sharing list is not, and one shared
          // drive refusing is no reason to return nothing.
          continue;
        }

        for (const person of people) {
          if (person.email === actor) continue;

          const existing = found.get(person.email);

          if (existing === undefined) {
            found.set(person.email, {
              email: person.email,
              displayName: person.displayName,
              fileCount: 1,
            });
            continue;
          }

          found.set(person.email, {
            ...existing,
            // A later file may carry the name an earlier one omitted.
            displayName: existing.displayName ?? person.displayName,
            fileCount: existing.fileCount + 1,
          });
        }
      }

      // Most widely shared first: the people on every file are the colleagues,
      // and the address breaks ties so the order never wobbles between reads.
      return [...found.values()].sort(
        (left, right) =>
          right.fileCount - left.fileCount || left.email.localeCompare(right.email),
      );
    },
  };
}
