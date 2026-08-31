/**
 * Joins concurrent GETs of the same URL into one request.
 *
 * The dashboard now has two independent readers of `/api/dashboard`: the
 * calendar, which needs the authorized timesheets, and the file lists, which
 * need the same listing plus the managed files for a remembered folder. Left
 * alone they issue two identical requests on every visit, and each one is a
 * full Drive scan plus a configuration read per file on the user's own quota.
 *
 * This is **coalescing, not caching**, and the difference is what makes it
 * safe: a request is shared only while it is still in flight, and an in-flight
 * request has not returned yet, so a joiner cannot receive anything staler than
 * the one it would have made itself. Once it settles the entry is dropped, so
 * the next call — a retry, a `Load files`, a later visit — always goes to the
 * server. There is no TTL to tune and no way to be served a previous answer.
 *
 * Each caller receives its own `clone()`, because a `Response` body can be read
 * only once and two callers would otherwise fight over it.
 */

const inFlight = new Map<string, Promise<Response>>();

export function sharedFetch(url: string, init?: RequestInit): Promise<Response> {
  const pending = inFlight.get(url);
  if (pending !== undefined) return pending.then((response) => response.clone());

  const request = fetch(url, init);
  inFlight.set(url, request);

  // Cleared on both settle paths, and only if this exact request is still the
  // registered one, so a slow failure cannot evict a newer request's entry.
  const clear = (): void => {
    if (inFlight.get(url) === request) inFlight.delete(url);
  };
  request.then(clear, clear);

  return request.then((response) => response.clone());
}

/** Test seam: forgets every in-flight entry. */
export function resetSharedFetch(): void {
  inFlight.clear();
}
