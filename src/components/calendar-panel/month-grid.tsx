import { fromIsoDate } from "@/lib/attendance/iso-date";
import type { CalendarDayState, CalendarSnapshot } from "@/lib/cache/calendar-state";
import { formatMonthLabel } from "@/components/month-label";

/**
 * One month of dates, drawn from the calendar's quick-info snapshot.
 *
 * The grid is a real `<table>` because that is what it is: dates in columns by
 * weekday, rows by week. A screen reader then announces the weekday column
 * without the cell having to repeat it, and the visible cell can stay a bare
 * day number while the accessible name carries the full date and its state.
 *
 * Every state is carried by a **word** in the accessible name and by a shape
 * (a dot, a hatch) as well as a wash, so nothing here depends on colour alone.
 *
 * Presentational: it reads a snapshot and `today`, and owns no loading, no
 * fetching, and no storage. `today` is the spreadsheet's own calendar day —
 * `null` when the file's timezone could not be determined, and then no date is
 * marked, because marking the wrong row is worse than marking none.
 */

const WEEKDAYS = [
  { short: "Sun", long: "Sunday" },
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
] as const;

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** A full readable date, built from the calendar fields — never `new Date(s)`. */
function readableDate(date: string): string {
  const parsed = fromIsoDate(date);
  if (parsed === null) return date;

  return DATE_FORMAT.format(
    new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())),
  );
}

function dayNumber(date: string): string {
  return String(fromIsoDate(date)?.getDate() ?? date.slice(-2));
}

function weekdayIndex(date: string): number {
  return fromIsoDate(date)?.getDay() ?? 0;
}

/** The state sentence a screen reader hears. The cell shows only a number. */
function describeDay(day: CalendarDayState, isToday: boolean): string {
  const parts = [readableDate(day.date)];

  parts.push(day.record === "recorded" ? "Recorded" : "Not recorded");
  if (day.nonWorking === "weekend") parts.push("weekend");
  if (day.nonWorking === "calendar-context") parts.push("non-working day");
  if (day.workHours !== null) parts.push(`${day.workHours} hours`);
  if (isToday) parts.push("today");

  return parts.join(", ");
}

/** Rows of seven, with leading blanks so the first date lands under its weekday. */
function toWeeks(days: readonly CalendarDayState[]): (CalendarDayState | null)[][] {
  if (days.length === 0) return [];

  const cells: (CalendarDayState | null)[] = Array.from(
    { length: weekdayIndex(days[0].date) },
    () => null,
  );
  cells.push(...days);

  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (CalendarDayState | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) {
    weeks.push(cells.slice(start, start + 7));
  }

  return weeks;
}

export interface MonthGridProps {
  snapshot: CalendarSnapshot;
  /** `YYYY-MM-DD` in the spreadsheet's own zone, or `null`. */
  today: string | null;
}

export function MonthGrid({ snapshot, today }: MonthGridProps) {
  const weeks = toWeeks(snapshot.days);

  return (
    <table className="month-grid">
      <caption className="month-grid-caption">
        {formatMonthLabel(snapshot.month) ?? snapshot.month} · {snapshot.sheetTitle}
      </caption>

      <thead>
        <tr>
          {WEEKDAYS.map((weekday) => (
            <th key={weekday.short} scope="col" abbr={weekday.long}>
              {weekday.short}
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {weeks.map((week, index) => (
          // Weeks have no identity of their own; the first cell that exists
          // names the row.
          <tr key={week.find((day) => day !== null)?.date ?? `week-${index}`}>
            {week.map((day, position) =>
              day === null ? (
                <td key={`empty-${position}`} className="month-grid-cell is-empty" />
              ) : (
                <td
                  key={day.date}
                  className="month-grid-cell"
                  data-record={day.record}
                  data-non-working={day.nonWorking ?? undefined}
                  data-today={day.date === today ? "true" : undefined}
                >
                  {/* F1's published hidden-text primitive; not a private one. */}
                  <span className="sr-only">{describeDay(day, day.date === today)}</span>

                  <time className="month-grid-date tabular" dateTime={day.date} aria-hidden="true">
                    {dayNumber(day.date)}
                  </time>

                  <span className="month-grid-mark" aria-hidden="true" />

                  {day.workHours === null ? null : (
                    <span className="month-grid-hours tabular" aria-hidden="true">
                      {day.workHours}h
                    </span>
                  )}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The legend that keeps every marker above explainable without colour. */
export function MonthGridLegend({ hasToday }: { hasToday: boolean }) {
  return (
    <ul className="month-grid-legend">
      <li data-record="recorded">
        <span className="month-grid-mark" aria-hidden="true" />
        Recorded
      </li>
      <li data-record="not-recorded">
        <span className="month-grid-mark" aria-hidden="true" />
        Not recorded
      </li>
      <li data-non-working="weekend">
        <span className="month-grid-mark" aria-hidden="true" />
        Non-working day
      </li>
      {hasToday ? (
        <li data-today="true">
          <span className="month-grid-mark" aria-hidden="true" />
          Today in this spreadsheet
        </li>
      ) : null}
    </ul>
  );
}
