/**
 * The spreadsheet's own calendar day.
 *
 * `Today` in this application is the day it is *in the selected spreadsheet's
 * timezone* — the value Sheets reports as `spreadsheet.properties.timeZone`.
 * It is never UTC and never the browser or server device timezone: a person in
 * Tokyo and a person in Los Angeles looking at the same workbook must agree on
 * which row is today, and only the workbook's own zone can settle that.
 *
 * When the zone is missing or is not a real IANA identifier, every function
 * here answers `null`. That is deliberate: the calendar stays navigable and
 * reports that the timezone could not be determined rather than guessing a
 * zone and silently highlighting the wrong day.
 *
 * Pure: no I/O, no React, no Google types.
 */

/**
 * Characters an IANA zone identifier is built from.
 *
 * This deliberately excludes `:`, which rejects both a bare UTC offset
 * (`+09:00`) and the `GMT-07:00` custom form Sheets documents as its fallback
 * when a spreadsheet's zone is not a recognized CLDR name. Neither is an IANA
 * zone, and neither may be quietly reinterpreted as one.
 */
const IANA_SHAPE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

/** True when `value` is an identifier the runtime resolves as an IANA zone. */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const candidate = value.trim();
  if (candidate === "" || !IANA_SHAPE.test(candidate)) return false;

  try {
    // The constructor throws `RangeError` for an unknown zone; there is no
    // non-throwing lookup that is available across every supported runtime.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/**
 * The spreadsheet timezone in the form the rest of the app carries it.
 *
 * Returns the trimmed identifier, or `null` for anything unusable. There is no
 * fallback value by design.
 */
export function normalizeSpreadsheetTimeZone(value: string | null | undefined): string | null {
  if (!isIanaTimeZone(value)) return null;
  return value.trim();
}

function partOf(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * The `YYYY-MM-DD` calendar day at `instant` in the spreadsheet's zone.
 *
 * `null` when the zone is missing or invalid — the caller disables `Today`
 * rather than falling back to another zone.
 */
export function todayInZone(
  timeZone: string | null | undefined,
  instant: Date = new Date(),
): string | null {
  const zone = normalizeSpreadsheetTimeZone(timeZone);
  if (zone === null || Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const year = partOf(parts, "year").padStart(4, "0");
  const month = partOf(parts, "month").padStart(2, "0");
  const day = partOf(parts, "day").padStart(2, "0");

  return `${year}-${month}-${day}`;
}
