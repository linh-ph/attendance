/**
 * Editable member rows for a file that does not exist yet.
 *
 * This is the *draft* roster of the create wizard, not the product roster:
 * `MemberRows` shows members Google already knows about and deliberately has no
 * removal action, while a row here can still be removed because nothing has
 * been created — removing a draft row is not the destructive member-removal
 * operation, which is out of scope for the first version (section 2.1).
 *
 * Every input carries an explicit, indexed label and is associated with its own
 * error message, so a screen reader announces which row is wrong.
 */

export interface DraftMember {
  /** Stable local key; never sent to the server. */
  id: string;
  displayName: string;
  email: string;
}

export interface DraftMemberErrors {
  displayName?: string;
  email?: string;
}

export interface MemberInputsProps {
  members: readonly DraftMember[];
  /** Errors keyed by draft member id. */
  errors?: Readonly<Record<string, DraftMemberErrors>>;
  onChange: (id: string, patch: Partial<Omit<DraftMember, "id">>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}

interface FieldProps {
  id: string;
  label: string;
  type: "text" | "email";
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function MemberField({ id, label, type, value, error, disabled, onChange }: FieldProps) {
  const errorId = `${id}-error`;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.target.value)}
      />
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function MemberInputs({
  members,
  errors = {},
  onChange,
  onAdd,
  onRemove,
  disabled = false,
}: MemberInputsProps) {
  return (
    <div className="member-inputs">
      <ul className="member-input-list">
        {members.map((member, index) => {
          const position = index + 1;
          const rowErrors = errors[member.id] ?? {};

          return (
            <li className="member-input-row" key={member.id} aria-label={`Employee ${position}`}>
              <MemberField
                id={`member-name-${member.id}`}
                label={`Employee name ${position}`}
                type="text"
                value={member.displayName}
                error={rowErrors.displayName}
                disabled={disabled}
                onChange={(value) => onChange(member.id, { displayName: value })}
              />

              <MemberField
                id={`member-email-${member.id}`}
                label={`Employee email ${position}`}
                type="email"
                value={member.email}
                error={rowErrors.email}
                disabled={disabled}
                onChange={(value) => onChange(member.id, { email: value })}
              />

              <button
                type="button"
                className="action"
                disabled={disabled}
                onClick={() => onRemove(member.id)}
              >
                {`Remove employee ${position}`}
              </button>
            </li>
          );
        })}
      </ul>

      <button type="button" className="action" disabled={disabled} onClick={onAdd}>
        Add employee
      </button>
    </div>
  );
}
