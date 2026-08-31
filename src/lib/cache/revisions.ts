/**
 * Baseline hashing and monotonic local revisions.
 *
 * Pure: no IndexedDB, no React, no Google types.
 *
 * Two independent guarantees live here.
 *
 * 1. **Byte-for-byte baselines.** A stored draft is restored only onto a row
 *    identical to the one it was made against (spec §5.2). `sameBaseline`
 *    compares canonical serializations, not hashes, so the rule is exact
 *    rather than probabilistic. The hash is a cheap fingerprint used for
 *    change detection and disclosure only.
 * 2. **Monotonic revisions.** Every draft write advances a local revision. A
 *    Save clears a draft only when the stored revision equals the one it sent,
 *    so an edit made while the request was in flight stays pending (spec §5.5).
 */

import type { AttendanceDay } from "@/lib/attendance/model";

export const INITIAL_REVISION = 0;

/**
 * JSON with object keys sorted at every depth, so two rows read identically
 * serialize identically regardless of property order. Array order stays
 * significant, and an explicit `null` stays distinct from an absent property.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }

    return sorted;
  }

  return value;
}

/**
 * A 64-bit fingerprint built from two independently seeded FNV-1a passes.
 * Not a security primitive: it detects change, and `sameBaseline` — not this —
 * decides whether a draft may be restored.
 */
export function hashValue(value: unknown): string {
  const text = canonicalJson(value);

  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x01000193)}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

export function hashDay(day: AttendanceDay): string {
  return hashValue(day);
}

/** True only when the two rows are byte-for-byte the same day. */
export function sameBaseline(left: AttendanceDay, right: AttendanceDay): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * The next local revision. A missing or nonsensical stored value restarts at
 * 1 rather than going backwards, so a corrupted record can never make a newer
 * draft look older than one already stored.
 */
export function nextRevision(current: number | null | undefined): number {
  if (typeof current !== "number" || !Number.isFinite(current) || current < INITIAL_REVISION) {
    return INITIAL_REVISION + 1;
  }

  return Math.floor(current) + 1;
}
