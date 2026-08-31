/**
 * Request epochs.
 *
 * Pure bookkeeping: no IndexedDB, no React, no timers.
 *
 * Spec §5.5: a file/sheet/month context owns a monotonically increasing request
 * epoch, and a load or revalidation response may update visible state or
 * IndexedDB **only if** its context is still selected *and* its epoch is the
 * latest issued for that context.
 *
 * Both halves matter and neither is sufficient alone:
 *
 * - latest-epoch alone lets a response for a sheet the person has navigated
 *   away from repaint the screen;
 * - still-selected alone lets a slow first fetch overwrite the newer
 *   revalidation of the same sheet.
 *
 * The counter is shared across contexts, so epochs are comparable everywhere
 * and a switch away and back never reuses a number.
 */

export interface EpochRegistry {
  /** Issues a fresh epoch for `key` and makes it the selected context. */
  select(key: string): number;
  /** Issues a fresh epoch for `key` without changing what is selected. */
  issue(key: string): number;
  /** The latest epoch issued for `key`, or `null` if it never was. */
  latest(key: string): number | null;
  /** The selected context key, or `null` when nothing is selected. */
  selected(): string | null;
  /** True only when `key` is selected and `epoch` is its latest. */
  accepts(key: string, epoch: number): boolean;
  /** Drops the selection, so every in-flight response is refused. */
  deselect(): void;
}

export function createEpochRegistry(): EpochRegistry {
  const latestByKey = new Map<string, number>();
  let counter = 0;
  let selectedKey: string | null = null;

  function issue(key: string): number {
    counter += 1;
    latestByKey.set(key, counter);
    return counter;
  }

  return {
    issue,

    select(key) {
      selectedKey = key;
      return issue(key);
    },

    latest(key) {
      return latestByKey.get(key) ?? null;
    },

    selected() {
      return selectedKey;
    },

    accepts(key, epoch) {
      return selectedKey === key && latestByKey.get(key) === epoch;
    },

    deselect() {
      selectedKey = null;
    },
  };
}
