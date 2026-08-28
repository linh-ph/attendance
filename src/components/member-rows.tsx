import type { MemberSetupStatus, MemberSummary } from "@/lib/files/member-service";

/**
 * Presentational roster used by the member page and the setup wizards.
 *
 * The component renders status and actions only. It never removes a member and
 * never revokes access: that is a separate destructive flow outside the first
 * version (section 2.1). `Retry invitation` appears only for a member whose
 * tab exists but whose Drive invitation failed, and only when the caller
 * supplies a handler for it.
 */

export const MEMBER_STATUS_LABELS: Record<MemberSetupStatus, string> = {
  ready: "Ready",
  pending: "Setting up",
  "invite-failed": "Invitation failed",
};

function spreadsheetUrl(fileId: string, sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${fileId}/edit#gid=${sheetId}`;
}

export interface MemberRowsProps {
  /** Google file ID; used only to build the direct link to each tab. */
  fileId: string;
  members: readonly MemberSummary[];
  /** Omit for a read-only roster: without it no row offers any action. */
  onRetryInvitation?: (email: string) => void;
  /** Normalized email whose retry is in flight; its button is disabled. */
  retryingEmail?: string | null;
  emptyMessage?: string;
}

export function MemberRows({
  fileId,
  members,
  onRetryInvitation,
  retryingEmail = null,
  emptyMessage = "No members yet.",
}: MemberRowsProps) {
  if (members.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  return (
    <ul className="member-list">
      {members.map((member) => (
        <li className="member-row" key={member.email} aria-label={member.displayName}>
          <p className="member-name">{member.displayName}</p>
          <p className="member-email">{member.email}</p>
          <p className={`member-status member-status-${member.setupStatus}`}>
            {MEMBER_STATUS_LABELS[member.setupStatus]}
          </p>

          <div className="member-actions">
            {member.sheetId === null ? null : (
              <a
                className="action"
                href={spreadsheetUrl(fileId, member.sheetId)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open sheet
              </a>
            )}

            {onRetryInvitation && member.setupStatus === "invite-failed" ? (
              <button
                type="button"
                className="action"
                disabled={retryingEmail === member.email}
                onClick={() => onRetryInvitation(member.email)}
              >
                {`Retry invitation for ${member.displayName}`}
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
