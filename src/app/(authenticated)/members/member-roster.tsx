"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { resolveLocalStore, type LocalStore } from "@/lib/dashboard/local-store";
import type { StoredMember } from "@/lib/dashboard/local-records";
import type { DirectoryPerson } from "@/lib/directory/people-directory";

/**
 * This browser's member roster: the colleagues offered when a file is created.
 *
 * Two ways in. Typing one, and importing the people Drive already reports as
 * having access to the attendance files this account can open — that import is
 * the only thing here that talks to Google, and it can only ever return what
 * Google was already willing to show this account.
 *
 * The roster is stored per signed-in address and is not authoritative: it
 * suggests names and addresses for a form, and every file operation is
 * authorized on its own.
 */

const NAME_REQUIRED = "Enter the member's name.";
const EMAIL_REQUIRED = "Enter the member's email address.";
const EMAIL_INVALID = "Enter a valid email address.";
const IMPORT_FAILED = "Could not read who else can reach your attendance files.";

export interface MemberRosterProps {
  /** The signed-in address; it scopes every stored record. */
  email: string;
  /** Injected by tests; the browser resolves IndexedDB. */
  store?: LocalStore;
}

interface ImportState {
  status: "idle" | "loading" | "failed";
  people: DirectoryPerson[];
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function MemberRoster({ email, store }: MemberRosterProps) {
  const localStore = useMemo(() => store ?? resolveLocalStore(), [store]);

  const [roster, setRoster] = useState<StoredMember[] | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ status: "idle", people: [] });

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

  function add(member: StoredMember): void {
    void localStore
      .addMember(email, member)
      .then(setRoster)
      .catch(() => undefined);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const name = displayName.trim();
    const address = memberEmail.trim().toLowerCase();

    if (name === "") {
      setError(NAME_REQUIRED);
      return;
    }
    if (address === "") {
      setError(EMAIL_REQUIRED);
      return;
    }
    if (!isEmail(address)) {
      setError(EMAIL_INVALID);
      return;
    }

    setError(null);
    setDisplayName("");
    setMemberEmail("");
    add({ email: address, displayName: name });
  }

  function handleImport(): void {
    setImportState({ status: "loading", people: [] });

    fetch("/api/directory", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { people?: DirectoryPerson[] }) => {
        setImportState({ status: "idle", people: body.people ?? [] });
      })
      .catch(() => {
        setImportState({ status: "failed", people: [] });
      });
  }

  if (roster === null) {
    return <p className="page-lede">Loading your members…</p>;
  }

  const known = new Set(roster.map((member) => member.email));
  const suggestions = importState.people.filter((person) => !known.has(person.email));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRoster = roster.filter((member) =>
    normalizedQuery === "" ||
    member.displayName.toLowerCase().includes(normalizedQuery) ||
    member.email.includes(normalizedQuery),
  );

  return (
    <div className="member-roster-workspace">
      <section className="surface-panel member-add-panel" aria-labelledby="add-roster-member">
        <div className="member-section-heading">
          <div>
            <p className="eyebrow">Roster</p>
            <h2 id="add-roster-member">Add member</h2>
          </div>
          <p className="page-lede">
            Browser-local shortcuts only. Adding someone here never grants Drive access.
          </p>
        </div>

        <form className="member-form" noValidate onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="roster-name">Name</label>
          <input
            id="roster-name"
            className="field-control"
            type="text"
            autoComplete="off"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setError(null);
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="roster-email">Email</label>
          <input
            id="roster-email"
            className="field-control"
            type="email"
            autoComplete="off"
            value={memberEmail}
            onChange={(event) => {
              setMemberEmail(event.target.value);
              setError(null);
            }}
          />
        </div>

        <button type="submit" className="action action-primary">
          Add member
        </button>
        </form>

        {error === null ? null : (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </section>

      <section className="surface-panel" aria-labelledby="saved-members-title">
        <div className="member-list-toolbar">
          <div>
            <p className="eyebrow">Saved in this browser</p>
            <h2 id="saved-members-title">Members</h2>
          </div>
          <label className="member-search">
            <span className="sr-only">Search members</span>
            <input
              type="search"
              aria-label="Search members"
              placeholder="Search name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {roster.length === 0 ? (
          <p className="page-lede">No members yet.</p>
        ) : visibleRoster.length === 0 ? (
          <p className="empty-state">No members match this search.</p>
        ) : (
          <ul className="member-roster-list">
            {visibleRoster.map((member) => (
              <li className="member-roster-card" key={member.email}>
                <div className="member-avatar" aria-hidden="true">
                  {member.displayName.trim().slice(0, 1).toUpperCase()}
                </div>
                <div className="member-roster-identity">
                  <h2>{member.displayName}</h2>
                  <p>{member.email}</p>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    void localStore
                      .removeMember(email, member.email)
                      .then(setRoster)
                      .catch(() => undefined);
                  }}
                >
                  Remove {member.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="import-title" className="surface-panel member-import-panel">
        <h2 id="import-title">Import from Drive</h2>
        <p className="page-lede">
          Reads who else can reach the attendance files you can already open. Nothing is added
          until you choose it.
        </p>

        <button
          type="button"
          className="action"
          disabled={importState.status === "loading"}
          onClick={handleImport}
        >
          {importState.status === "loading" ? "Reading Drive…" : "Find colleagues"}
        </button>

        {importState.status === "failed" ? (
          <p role="alert" className="field-error">
            {IMPORT_FAILED}
          </p>
        ) : null}

        {importState.status === "idle" && importState.people.length > 0 ? (
          suggestions.length === 0 ? (
            <p className="page-lede">Everyone Drive knows about is already on your list.</p>
          ) : (
            <ul className="member-roster-list member-suggestion-list">
              {suggestions.map((person) => (
                <li className="member-roster-card" key={person.email}>
                  <div className="member-avatar" aria-hidden="true">
                    {(person.displayName ?? person.email).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="member-roster-identity">
                    <h3>{person.displayName ?? person.email}</h3>
                    <p>{person.email}</p>
                  </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() =>
                        add({
                          email: person.email,
                          // Drive does not always know a name; the address is a
                          // usable placeholder the person can correct later.
                          displayName: person.displayName ?? person.email,
                        })
                      }
                    >
                      Add {person.displayName ?? person.email}
                    </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
