/**
 * `YYYY-MM` rendered as a readable English label such as `July 2026`.
 *
 * Months are stored and sent in the machine format the sheet contract uses;
 * only the display is localized, and only into English (section 4).
 */

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatMonthLabel(month: string): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month.trim());
  if (match === null) return null;

  return MONTH_FORMAT.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function MonthLabel({ month }: { month: string }) {
  return <>{formatMonthLabel(month) ?? month}</>;
}
