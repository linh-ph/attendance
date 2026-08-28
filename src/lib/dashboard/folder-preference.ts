export interface FolderPreference {
  id: string;
  name: string;
}

export const folderPreferenceKey = (email: string): string =>
  `attendance.dashboardFolder:${email.trim().toLowerCase()}`;

function isFolderPreference(value: unknown): value is FolderPreference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0
  );
}

function removeStoredPreference(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable (private mode / disabled); nothing to clean up.
  }
}

/**
 * Reads the last selected dashboard folder for the given signed-in email.
 * This preference is a browser-only convenience: it is never authoritative
 * and the server always revalidates the folder. Any malformed or
 * structurally invalid stored value is treated as "no preference" and is
 * removed from storage.
 */
export function readFolderPreference(email: string): FolderPreference | null {
  const key = folderPreferenceKey(email);

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }

  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeStoredPreference(key);
    return null;
  }

  if (!isFolderPreference(parsed)) {
    removeStoredPreference(key);
    return null;
  }

  return { id: parsed.id, name: parsed.name };
}

/**
 * Replaces the stored dashboard folder preference for the given email.
 * This never moves or mutates any Drive file; it only remembers the last
 * selection for convenience.
 */
export function writeFolderPreference(email: string, preference: FolderPreference): void {
  const key = folderPreferenceKey(email);
  const payload: FolderPreference = { id: preference.id, name: preference.name };

  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Storage is unavailable (private mode / disabled); degrade to no preference.
  }
}

/**
 * Removes the stored dashboard folder preference for the given email only.
 */
export function clearFolderPreference(email: string): void {
  removeStoredPreference(folderPreferenceKey(email));
}
