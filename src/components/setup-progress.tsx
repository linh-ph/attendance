import { MemberRows } from "@/components/member-rows";
import type { MemberSummary } from "@/lib/files/member-service";

/**
 * The wizard grammar's recovery surface: what a manager sees when Drive kept
 * the file but a later setup step failed (spec section 7.3, section 9.2).
 *
 * A created or converted Drive file is never auto-deleted as rollback, so a
 * partial setup is never presented as a lost file. The file id, the folder that
 * has just become the active dashboard folder, and every member's retained
 * progress are shown together with the Resume action, and the optional retry is
 * for a flow that can safely re-run against that same retained file.
 *
 * The description is announced politely rather than by moving focus, because
 * this panel replaces the step the person was already looking at.
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
    <section className="section step setup-progress" aria-labelledby="setup-progress-heading">
      <h2 id="setup-progress-heading">Setup did not finish</h2>

      <p role="status" aria-live="polite" className="wizard-status wizard-status-attention">
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
          <button
            type="button"
            className="action"
            onClick={onRetry}
            disabled={isRetrying}
          >
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
