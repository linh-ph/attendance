/**
 * Conversions between the app's `YYYY-MM-DD` strings and `Date`.
 *
 * These exist because `new Date("2026-08-29")` is parsed as UTC midnight, which
 * is the *previous* calendar day for anyone west of Greenwich. A date picker
 * built on that would quietly offer the wrong day to half the world. Every
 * `Date` here is constructed and read in local fields, so the day a person sees
 * is the day the sheet stores.
 *
 * Pure: no I/O, no React, no Google types.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

/** Local midnight on the named day, or `null` when the string is not one. */
export function fromIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  // Rejects impossible dates: JavaScript rolls 2026-07-32 forward to August
  // rather than failing, so the round trip is the check.
  return toIsoDate(date) === value ? date : null;
}

export function toIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/** The first of the month, from either `YYYY-MM` or a full date. */
export function isoMonthStart(value: string): Date | null {
  const month = ISO_MONTH.exec(value);
  if (month) {
    return new Date(Number(month[1]), Number(month[2]) - 1, 1);
  }

  const date = fromIsoDate(value);
  return date === null ? null : new Date(date.getFullYear(), date.getMonth(), 1);
}
