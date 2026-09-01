import { buildMonthGrid, weekdayOrder, type MonthGridCell } from "@/lib/attendance/calendar-grid";
import { nonWorkingDaySource, type NonWorkingDaySource } from "@/lib/attendance/day-state";
import { fromIsoDate } from "@/lib/attendance/iso-date";
import type { CalendarDayState } from "@/lib/cache/calendar-state";
import { formatMonthLabel } from "@/components/month-label";

/**
 * One month, drawn as a calendar.
 *
 * The grid comes from `buildMonthGrid`, which knows only the month — so the
 * calendar is drawn whether or not Google has anything for it. Attendance data
 * is an **overlay**: a date with a row in the sheet shows `Recorded` or
 * `Not recorded`, and a date without one shows the date, still under the right
 * weekday, still marked as a weekend if it is one. A month with no timesheet at
 * all is an ordinary empty calendar, never a missing panel.
 *
 * Because the grid is complete, the first and last rows carry real dates from
 * the neighbouring months, dimmed and announced as outside this month.
 *
 * Every state is carried by a **word** in the accessible name and by a shape as
 * well as a wash, so nothing here depends on colour alone.
 *
 * Presentational: it owns no loading, no fetching, and no storage. `today` is
 * the spreadsheet's own calendar day — `null` when the file's timezone could
 * not be determined, and then no date is marked, because marking the wrong row
 * is worse than marking none.
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

/** What one cell shows, after the overlay is applied to the calendar date. */
interface ResolvedCell {
  cell: MonthGridCell;
  /** `null` when the sheet has no row for this date — not the same as empty. */
  record: CalendarDayState["record"] | null;
  nonWorking: NonWorkingDaySource | null;
  workHours: number | null;
  isToday: boolean;
}

function resolve(
  cell: MonthGridCell,
  data: CalendarDayState | undefined,
  today: string | null,
): ResolvedCell {
  return {
    cell,
    record: data?.record ?? null,
    // Without sheet data the weekend is still knowable from the date itself,
    // which is what keeps an empty month looking like a calendar.
    nonWorking: data?.nonWorking ?? nonWorkingDaySource(cell.date),
    workHours: data?.workHours ?? null,
    isToday: cell.date === today,
  };
}

/** The state sentence a screen reader hears. The cell shows only a number. */
function describe(resolved: ResolvedCell, month: string): string {
  const parts = [readableDate(resolved.cell.date)];

  if (!resolved.cell.inMonth) {
    parts.push(`outside ${formatMonthLabel(month) ?? month}`);
  }

  parts.push(
    resolved.record === null
      ? "No timesheet data"
      : resolved.record === "recorded"
        ? "Recorded"
        : "Not recorded",
  );

  if (resolved.nonWorking === "weekend") parts.push("weekend");
  if (resolved.nonWorking === "calendar-context") parts.push("non-working day");
  if (resolved.workHours !== null) parts.push(`${resolved.workHours} hours`);
  if (resolved.isToday) parts.push("today");

  return parts.join(", ");
}

export interface MonthGridProps {
  /** `YYYY-MM`. The grid is built from this alone. */
  month: string;
  /** The overlay. Empty, partial, or absent are all ordinary. */
  days?: readonly CalendarDayState[];
  /** Named in the caption when a timesheet is loaded. */
  sheetTitle?: string | null;
  /** `YYYY-MM-DD` in the spreadsheet's own zone, or `null`. */
  today: string | null;
  /** `0` = Sunday. */
  weekStartsOn?: number;
}

export function MonthGrid({
  month,
  days = [],
  sheetTitle,
  today,
  weekStartsOn = 0,
}: MonthGridProps) {
  const weeks = buildMonthGrid(month, { weekStartsOn });
  const overlay = new Map(days.map((day) => [day.date, day]));
  const label = formatMonthLabel(month) ?? month;

  if (weeks.length === 0) return null;

  return (
    <table className="month-grid">
      <caption className="sr-only">
        {sheetTitle ? `${label} · ${sheetTitle}` : label}
      </caption>

      <thead>
        <tr>
          {weekdayOrder(weekStartsOn).map((index) => (
            <th key={WEEKDAYS[index].short} scope="col" abbr={WEEKDAYS[index].long}>
              {WEEKDAYS[index].short}
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {weeks.map((week) => (
          <tr key={week.key}>
            {week.cells.map((cell) => {
              const resolved = resolve(cell, overlay.get(cell.date), today);

              return (
                <td
                  key={cell.date}
                  className="month-grid-cell"
                  data-record={resolved.record ?? "no-data"}
                  data-outside={cell.inMonth ? undefined : "true"}
                  data-non-working={resolved.nonWorking ?? undefined}
                  data-today={resolved.isToday ? "true" : undefined}
                >
                  <span className="sr-only">{describe(resolved, month)}</span>

                  <time className="month-grid-date tabular" dateTime={cell.date} aria-hidden="true">
                    {dayNumber(cell.date)}
                  </time>

                  {resolved.record === null ? null : (
                    <span className="month-grid-mark" aria-hidden="true" />
                  )}

                  {resolved.workHours === null ? null : (
                    <span className="month-grid-hours tabular" aria-hidden="true">
                      {resolved.workHours}h
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface MonthGridLegendProps {
  hasToday: boolean;
  /** `false` while the month carries no attendance data to explain. */
  hasData: boolean;
}

/** The legend that keeps every marker above explainable without colour. */
export function MonthGridLegend({ hasToday, hasData }: MonthGridLegendProps) {
  return (
    <ul className="month-grid-legend">
      {hasData ? (
        <>
          <li data-record="recorded">
            <span className="month-grid-mark" aria-hidden="true" />
            Recorded
          </li>
          <li data-record="not-recorded">
            <span className="month-grid-mark" aria-hidden="true" />
            Not recorded
          </li>
        </>
      ) : (
        <li data-record="no-data">
          <span className="month-grid-mark" aria-hidden="true" />
          No timesheet data
        </li>
      )}

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
