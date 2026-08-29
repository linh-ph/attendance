import { MemberRows } from "@/components/member-rows";
import type { MemberSummary } from "@/lib/files/member-service";

/**
 * What a manager sees when Drive kept the file but a later setup step failed
 * (section 9.2).
 *
 * A partial setup is never presented as a lost file: the file id, the folder
 * that has just become the active dashboard folder, and every member's retained
 * progress are shown together with the resume action. The optional retry is for
 * a flow that can safely re-run against the same retained file.
 */

export interface SetupProgressProps {
  fileId: string;
  fileName: string;
  folderName: string;
  /** Says, in English, what was kept and what is left to do. */
  description: string;
  members: readonly MemberSummary[];
  onRetry?: () => void;
  retryLabel?: string;
  isRetrying?: boolean;
}

export function SetupProgress({
  fileId,
  fileName,
  folderName,
  description,
  members,
  onRetry,
  retryLabel = "Retry setup",
  isRetrying = false,
}: SetupProgressProps) {
  return (
    <section className="section step" aria-labelledby="setup-progress-heading">
      <h2 id="setup-progress-heading">Setup did not finish</h2>

      <p role="status" className="form-status">
        {description}
      </p>

      <dl className="card-facts">
        <div className="card-fact">
          <dt>File</dt>
          <dd>{fileName}</dd>
        </div>
        <div className="card-fact">
          <dt>Destination folder</dt>
          <dd>{folderName}</dd>
        </div>
      </dl>

      <MemberRows
        fileId={fileId}
        members={members}
        emptyMessage="No member sheets were created yet."
      />

      <div className="card-actions">
        {onRetry ? (
          <button type="button" className="action" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? "Retrying setup…" : retryLabel}
          </button>
        ) : null}

        <a className="action action-primary" href={`/files/${fileId}/setup`}>
          Resume setup
        </a>

        <a
          className="action"
          href={`https://docs.google.com/spreadsheets/d/${fileId}/edit`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in Google Sheets
        </a>
      </div>
    </section>
  );
}
