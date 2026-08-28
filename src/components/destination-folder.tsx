import { ApiErrorNotice, requestApi, type ApiFailure } from "@/components/api-error-notice";
import { GooglePicker } from "@/components/google-picker";
import type { FolderPreference } from "@/lib/dashboard/folder-preference";

/**
 * Destination-folder control shared by the create and import wizards.
 *
 * A folder is only ever chosen through Google Picker, and the ID it returns is
 * never trusted: the caller sends it to `POST /api/folders/validate`, which
 * confirms with Drive that it is an untrashed, owned, writable My Drive folder
 * before it can be used as a destination (section 2.5). This component shows
 * the confirmed name and both failure kinds; the validation itself stays with
 * the wizard so it can be injected in tests.
 */

const FOLDER_CHECK_FAILED = "Could not validate the selected folder.";

/** Sends a picked or remembered folder ID for revalidation by Drive. */
export async function validateDestinationFolder(folderId: string): Promise<FolderPreference> {
  const { body } = await requestApi<{ folder: FolderPreference }>("/api/folders/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId }),
  });

  return body.folder;
}

export interface DestinationFolderProps {
  /** The folder Drive confirmed, or `null` while none is usable. */
  folder: FolderPreference | null;
  /** Client-side message, such as a missing destination on submit. */
  error?: string;
  /** Server answer for the last revalidation attempt. */
  failure: ApiFailure | null;
  onSelect: (picked: FolderPreference) => void;
  disabled?: boolean;
}

export function DestinationFolder({
  folder,
  error,
  failure,
  onSelect,
  disabled = false,
}: DestinationFolderProps) {
  return (
    <div className="field folder-control">
      <p className="field-label">Destination folder</p>

      {folder === null ? null : <p className="folder-name">{folder.name}</p>}

      <GooglePicker
        mode="folder"
        label={folder === null ? "Select destination folder" : "Change folder"}
        onSelect={onSelect}
        disabled={disabled}
      />

      {error === undefined ? null : (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <ApiErrorNotice failure={failure} fallbackMessage={FOLDER_CHECK_FAILED} />
    </div>
  );
}
