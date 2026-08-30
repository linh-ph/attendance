"use client";

import { useEffect, useMemo, useState } from "react";
import { resolveLocalStore, type LocalStore } from "@/lib/dashboard/local-store";
import type { StoredMember } from "@/lib/dashboard/local-records";

/**
 * Offers this browser's member roster while a file is being created.
 *
 * It is a shortcut for typing, nothing more: choosing somebody fills a row the
 * person can still edit or remove, and the roster itself is only what this
 * browser has stored under the signed-in address. Anyone already on the draft
 * is left out, so the same colleague cannot be added twice.
 *
 * When the roster is empty the whole block stays out of the way rather than
 * showing an empty shelf — there is a link to fill it instead.
 */

export interface RosterPickerProps {
  /** The signed-in address; it scopes the stored roster. */
  email: string;
  /** Addresses already on the draft roster, normalized. */
  taken: readonly string[];
  onPick: (member: StoredMember) => void;
  disabled?: boolean;
  /** Injected by tests; the browser resolves IndexedDB. */
  store?: LocalStore;
}

export function RosterPicker({ email, taken, onPick, disabled = false, store }: RosterPickerProps) {
  const localStore = useMemo(() => store ?? resolveLocalStore(), [store]);
  const [roster, setRoster] = useState<StoredMember[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    localStore
      .readMembers(email)
      .then((stored) => {
        if (!cancelled) setRoster(stored);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });

    return () => {
      cancelled = true;
    };
  }, [email, localStore]);

  if (roster === null || roster.length === 0) return null;

  const alreadyOnDraft = new Set(taken);
  const available = roster.filter((member) => !alreadyOnDraft.has(member.email));

  if (available.length === 0) return null;

  return (
    <div className="roster-picker">
      <h3 className="roster-picker-title">Add from your members</h3>
      <ul className="roster-picker-list">
        {available.map((member) => (
          <li key={member.email}>
            <button
              type="button"
              className="action"
              disabled={disabled}
              onClick={() => onPick(member)}
            >
              {member.displayName} · {member.email}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
