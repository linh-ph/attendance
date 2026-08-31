/**
 * Cross-tab revision notices.
 *
 * Spec §5.5: tabs editing the same account/file/sheet/date broadcast revision
 * changes and use the same transactional revision comparison. The comparison is
 * what makes a stale write *safe*; this channel is what makes the stale tab
 * *aware*, so it can re-read or surface `Remote changes detected` instead of
 * sitting on a draft the other tab has already moved past.
 *
 * A message carries a key and a revision — never a day, a note, an email
 * address on its own, or anything else. Two tabs of the same profile are the
 * only listeners (BroadcastChannel is same-origin), and even so there is no
 * reason to put content on the wire when a revision number is enough to make
 * the other tab re-read from storage it already shares.
 */

export type RevisionScope = "draft" | "month";

export interface RevisionMessage {
  scope: RevisionScope;
  /** The storage key whose revision changed. Contains no day content. */
  key: string;
  revision: number;
}

export type RevisionListener = (message: RevisionMessage) => void;

export interface RevisionBroadcast {
  publish(message: RevisionMessage): void;
  subscribe(listener: RevisionListener): () => void;
  close(): void;
}

export const REVISION_CHANNEL_NAME = "attendance-local-revisions";

/** Used when the browser has no BroadcastChannel; storage still works. */
export function createNullBroadcast(): RevisionBroadcast {
  return {
    publish() {},
    subscribe() {
      return () => {};
    },
    close() {},
  };
}

export function createBroadcastChannelBroadcast(name = REVISION_CHANNEL_NAME): RevisionBroadcast {
  const channel = new BroadcastChannel(name);
  const listeners = new Set<RevisionListener>();

  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = asRevisionMessage(event.data);
    if (message === null) return;

    for (const listener of listeners) listener(message);
  };

  return {
    publish(message) {
      try {
        channel.postMessage(message);
      } catch {
        // A closed channel must never break a write that already succeeded.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel.close();
    },
  };
}

/** Structural check: another tab's message is untrusted input like any other. */
function asRevisionMessage(value: unknown): RevisionMessage | null {
  if (value === null || typeof value !== "object") return null;

  const candidate = value as Partial<RevisionMessage>;

  if (candidate.scope !== "draft" && candidate.scope !== "month") return null;
  if (typeof candidate.key !== "string" || candidate.key.length === 0) return null;
  if (typeof candidate.revision !== "number" || !Number.isFinite(candidate.revision)) return null;

  return { scope: candidate.scope, key: candidate.key, revision: candidate.revision };
}

/**
 * An in-process stand-in for BroadcastChannel, so a test can wire two caches
 * together and prove the two-tab rules without a browser.
 */
export function createMemoryBroadcastHub(): { connect(): RevisionBroadcast } {
  const ports = new Set<{ listeners: Set<RevisionListener> }>();

  return {
    connect() {
      const port = { listeners: new Set<RevisionListener>() };
      ports.add(port);

      return {
        publish(message) {
          for (const other of ports) {
            if (other === port) continue; // A tab does not hear itself.
            for (const listener of other.listeners) listener(message);
          }
        },
        subscribe(listener) {
          port.listeners.add(listener);
          return () => port.listeners.delete(listener);
        },
        close() {
          port.listeners.clear();
          ports.delete(port);
        },
      };
    },
  };
}

export function resolveRevisionBroadcast(): RevisionBroadcast {
  if (typeof BroadcastChannel === "undefined") return createNullBroadcast();

  try {
    return createBroadcastChannelBroadcast();
  } catch {
    return createNullBroadcast();
  }
}
