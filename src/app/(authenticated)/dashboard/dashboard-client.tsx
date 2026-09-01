"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorNotice } from "@/components/api-error-notice";
import { DayQuickPreview } from "@/components/day-quick-preview/day-quick-preview";
import { MonthCalendar } from "@/components/month-calendar/month-calendar";
import { MonthLabel, formatMonthLabel } from "@/components/month-label";
import { StateNotice, StateSkeleton, SyncStatus, type SyncState } from "@/components/sync-status";
import { shiftMonth } from "@/lib/attendance/calendar-grid";
import { todayInZone } from "@/lib/attendance/zone";
import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView, AttendanceRole } from "@/lib/attendance/service";
import { resolveAttendanceCache, type AttendanceCache } from "@/lib/cache/attendance-cache";
import {
  resolveCalendarPointerStore,
  type CalendarPointerStore,
} from "@/lib/cache/calendar-pointer";
import type { CacheContext } from "@/lib/cache/keys";
import { stripAuthorization, type CachedMonthView } from "@/lib/cache/records";
import type { FolderPreference } from "@/lib/dashboard/folder-preference";
import type { ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import type { GoogleErrorDiagnostic } from "@/lib/google/errors";

interface DashboardClientProps {
  email: string;
  /** Injected by component tests; production resolves the IndexedDB cache once. */
  cache?: AttendanceCache;
  /** Records which month the calendar is on, so a cold open can find it. */
  pointer?: CalendarPointerStore;
  /** Keeps the current-month and timezone edge cases deterministic in tests. */
  now?: Date;
}

interface DashboardResponse {
  folder: FolderPreference | null;
  managed: ManagedFile[];
  timesheets: Timesheet[];
  folderError?: string;
}

interface DashboardErrorResponse {
  error?: string;
  debug?: GoogleErrorDiagnostic;
}

type DashboardState =
  | { status: "loading" }
  | { status: "loaded"; data: DashboardResponse }
  | { status: "failed"; message: string; diagnostic?: GoogleErrorDiagnostic; expired: boolean };

interface CalendarViewState {
  view: CachedMonthView;
  role: AttendanceRole | null;
  checkedAt: string | null;
  source: "cache" | "remote";
  syncState: SyncState;
  message: string;
  localDates: Set<string>;
  attentionDates: Set<string>;
}

type CalendarState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: CalendarViewState }
  | { status: "failed"; message: string; expired: boolean; diagnostic?: GoogleErrorDiagnostic };

const LOAD_FAILED = "Could not load your dashboard.";
const MONTH_LOAD_FAILED = "Could not load this attendance month.";

function currentMonthAt(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function isMonthView(value: unknown): value is AttendanceMonthView {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AttendanceMonthView>;
  return (
    typeof candidate.fileId === "string" &&
    typeof candidate.sheetId === "number" &&
    typeof candidate.sheetTitle === "string" &&
    typeof candidate.month === "string" &&
    Array.isArray(candidate.statuses) &&
    Array.isArray(candidate.days)
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fetchDashboard(): Promise<DashboardState> {
  let response: Response;
  try {
    response = await fetch("/api/dashboard", { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { status: "failed", message: LOAD_FAILED, expired: false };
  }

  const body = (await readJson(response)) as unknown as DashboardResponse & DashboardErrorResponse;
  if (response.ok) return { status: "loaded", data: body };

  return {
    status: "failed",
    message: typeof body.error === "string" ? body.error : LOAD_FAILED,
    diagnostic: body.debug,
    expired: response.status === 401,
  };
}

async function fetchMonth(timesheet: Timesheet): Promise<
  | { ok: true; view: AttendanceMonthView }
  | { ok: false; message: string; expired: boolean; diagnostic?: GoogleErrorDiagnostic }
> {
  if (timesheet.sheetId === null) {
    return { ok: false, message: "Choose your tab before opening this month.", expired: false };
  }

  let response: Response;
  try {
    response = await fetch(`/api/files/${timesheet.id}/attendance/${timesheet.sheetId}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, message: MONTH_LOAD_FAILED, expired: false };
  }

  const body = await readJson(response);
  if (response.ok && isMonthView(body)) return { ok: true, view: body };

  return {
    ok: false,
    message: typeof body.error === "string" ? body.error : MONTH_LOAD_FAILED,
    expired: response.status === 401,
    diagnostic: body.debug as GoogleErrorDiagnostic | undefined,
  };
}

function mappedCandidates(timesheets: readonly Timesheet[], month: string): Timesheet[] {
  return timesheets.filter((timesheet) => timesheet.month === month);
}

function uniqueMappedCandidate(timesheets: readonly Timesheet[], month: string): Timesheet | null {
  const candidates = mappedCandidates(timesheets, month);
  return candidates.length === 1 ? candidates[0] : null;
}

function availableMonths(timesheets: readonly Timesheet[]): string[] {
  return [...new Set(timesheets.map((timesheet) => timesheet.month).filter((month): month is string => month !== null))]
    .sort();
}

function checkedLabel(checkedAt: string | null, timeZone: string | null | undefined): string | null {
  if (checkedAt === null) return null;
  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) return null;

  try {
    return `Last checked ${new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(parsed)}`;
  } catch {
    return `Last checked ${parsed.toISOString()}`;
  }
}

async function restoreVisibleDrafts(
  cache: AttendanceCache,
  context: CacheContext,
  view: CachedMonthView,
): Promise<{ view: CachedMonthView; localDates: Set<string>; attentionDates: Set<string> }> {
  const restored = await Promise.all(
    view.days.map(async (day) => ({ day, result: await cache.restoreDraft(context, day.date, day) })),
  );
  const localDates = new Set<string>();
  const attentionDates = new Set<string>();
  const days = restored.map(({ day, result }) => {
    if (!result.ok) return day;
    if (result.value.status === "restored") {
      localDates.add(day.date);
      return result.value.record.day;
    }
    if (result.value.status === "discarded") attentionDates.add(day.date);
    return day;
  });

  return { view: { ...view, days }, localDates, attentionDates };
}

export function DashboardClient({
  email,
  cache: cacheProp,
  pointer: pointerProp,
  now: nowProp,
}: DashboardClientProps) {
  const [cache] = useState<AttendanceCache>(() => cacheProp ?? resolveAttendanceCache());
  const [pointer] = useState<CalendarPointerStore>(
    () => pointerProp ?? resolveCalendarPointerStore(),
  );
  const [dashboard, setDashboard] = useState<DashboardState>({ status: "loading" });
  const [calendar, setCalendar] = useState<CalendarState>({ status: "idle" });
  const [selectedMonth, setSelectedMonth] = useState(() => currentMonthAt(nowProp ?? new Date()));
  const [chosenTimesheet, setChosenTimesheet] = useState<Timesheet | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTrigger, setSelectedTrigger] = useState<HTMLButtonElement | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);

  const reloadDashboard = useCallback(() => {
    setDashboard({ status: "loading" });
    void fetchDashboard().then(setDashboard);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDashboard().then((result) => {
      if (!cancelled) setDashboard(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const timesheets = useMemo(
    () => (dashboard.status === "loaded" ? dashboard.data.timesheets : []),
    [dashboard],
  );
  const candidates = useMemo(
    () => mappedCandidates(timesheets, selectedMonth),
    [selectedMonth, timesheets],
  );
  const automatic = useMemo(
    () => uniqueMappedCandidate(timesheets, selectedMonth),
    [selectedMonth, timesheets],
  );
  const activeTimesheet =
    chosenTimesheet?.month === selectedMonth && candidates.some((item) => item.id === chosenTimesheet.id)
      ? chosenTimesheet
      : automatic;

  useEffect(() => {
    if (!activeTimesheet || activeTimesheet.sheetId === null || activeTimesheet.month === null) return;

    let cancelled = false;
    const context: CacheContext = {
      email,
      fileId: activeTimesheet.id,
      sheetId: activeTimesheet.sheetId,
      month: activeTimesheet.month,
    };
    const epoch = cache.select(context);

    void (async () => {
      setCalendar({ status: "loading" });
      const cached = await cache.readMonth(context);
      const cachedRecord = cached.ok ? cached.value : null;

      if (!cancelled && cachedRecord) {
        const visible = await restoreVisibleDrafts(cache, context, cachedRecord.view);
        if (!cancelled) {
          setCalendar({
            status: "loaded",
            data: {
              ...visible,
              role: null,
              checkedAt: cachedRecord.checkedAt,
              source: "cache",
              syncState: "syncing",
              message: "Showing cached data while Google Sheets is checked in the background.",
            },
          });
        }
      }

      const remote = await fetchMonth(activeTimesheet);
      if (cancelled) return;

      if (!remote.ok) {
        if (cachedRecord) {
          const visible = await restoreVisibleDrafts(cache, context, cachedRecord.view);
          if (!cancelled) {
            setCalendar({
              status: "loaded",
              data: {
                ...visible,
                role: null,
                checkedAt: cachedRecord.checkedAt,
                source: "cache",
                syncState: "offline",
                message: "Showing cached data. Google Sheets could not be reached.",
              },
            });
          }
          return;
        }

        setCalendar({
          status: "failed",
          message: remote.message,
          expired: remote.expired,
          diagnostic: remote.diagnostic,
        });
        return;
      }

      const checkedAt = now.toISOString();
      const persisted = await cache.writeMonth(context, {
        view: remote.view,
        checkedAt,
        epoch,
        expectedRevision: cachedRecord?.revision ?? null,
      });
      const visible = await restoreVisibleDrafts(cache, context, stripAuthorization(remote.view));
      if (cancelled) return;

      const storageUnavailable = !persisted.ok;
      const conflictDates =
        persisted.ok && persisted.value.status === "written"
          ? new Set(persisted.value.conflictedDates)
          : new Set<string>();
      for (const date of visible.attentionDates) conflictDates.add(date);

      // The address of what was just stored, so a cold open — a reload, or an
      // open with no network — can find this month without discovery first.
      if (!storageUnavailable) void pointer.write(context).catch(() => undefined);

      setCalendar({
        status: "loaded",
        data: {
          ...visible,
          attentionDates: conflictDates,
          role: remote.view.role,
          checkedAt,
          source: "remote",
          syncState: storageUnavailable ? "local-storage-unavailable" : "synced",
          message: storageUnavailable
            ? "Calendar refreshed. Local storage is unavailable."
            : "Calendar refreshed from Google Sheets.",
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTimesheet, cache, email, now, pointer, reloadVersion]);

  /**
   * The month this browser already holds, when discovery cannot name a file.
   *
   * Discovery is what normally supplies the file and tab, and the effect above
   * reads the cache through them. With no candidate — an offline open, a failed
   * listing, a file that stopped being shared — there is no key to read, and
   * the calendar would sit empty over data the browser is already holding. The
   * pointer supplies that key, and only for the month actually on screen.
   */
  useEffect(() => {
    if (activeTimesheet !== null || dashboard.status === "loading") return;

    let cancelled = false;

    void (async () => {
      const stored = await pointer.read(email);
      if (cancelled || !stored.ok || stored.value === null) return;
      if (stored.value.month !== selectedMonth) return;

      const context: CacheContext = {
        email,
        fileId: stored.value.fileId,
        sheetId: stored.value.sheetId,
        month: stored.value.month,
      };

      const cached = await cache.readMonth(context);
      if (cancelled || !cached.ok || cached.value === null) return;

      const visible = await restoreVisibleDrafts(cache, context, cached.value.view);
      if (cancelled) return;

      setCalendar({
        status: "loaded",
        data: {
          ...visible,
          // Never a cached role: manager-only affordances stay absent until a
          // server response says otherwise.
          role: null,
          checkedAt: cached.value.checkedAt,
          source: "cache",
          syncState: "offline",
          message: "Showing this browser's copy. Google Sheets has not been reached yet.",
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTimesheet, cache, dashboard.status, email, pointer, selectedMonth]);

  /*
   * Month navigation is free. It used to step only between months that already
   * had a file, which made an account with one timesheet unable to look at any
   * other month at all. The grid is a property of the month, so moving is
   * always possible and an empty month simply says it is empty.
   */
  const previousMonth = shiftMonth(selectedMonth, -1);
  const nextMonth = shiftMonth(selectedMonth, 1);

  /*
   * The loaded month is an **overlay**, and only over its own month: a cached
   * July must not paint itself onto August while August is loading.
   */
  const data = calendar.status === "loaded" ? calendar.data : null;
  const overlay = data !== null && data.view.month === selectedMonth ? data : null;

  const todayDate = overlay ? todayInZone(overlay.view.spreadsheetTimeZone, now) : null;
  const todayAvailable =
    todayDate !== null && (overlay?.view.days.some((day) => day.date === todayDate) ?? false);
  const selectedDay = overlay?.view.days.find((day) => day.date === selectedDate) ?? null;
  const statusLabel = selectedDay
    ? overlay?.view.statuses.find((status) => status.code === selectedDay.statusCode)?.labelEn ??
      selectedDay.statusCode
    : null;
  const lastChecked = overlay
    ? checkedLabel(overlay.checkedAt, overlay.view.spreadsheetTimeZone)
    : null;

  /*
   * `idle` is deliberately not busy. It is the resting state whenever no
   * timesheet is active — an empty month, a choice still open — and counting it
   * as busy left `Sync sheet` disabled exactly when a person most wants to
   * press it, with the status pill stuck on `Syncing`.
   */
  const busy = dashboard.status === "loading" || calendar.status === "loading";

  function syncNow(): void {
    // The dashboard listing is refetched too, so a file shared or created a
    // moment ago is picked up rather than waiting for a page reload.
    reloadDashboard();
    setReloadVersion((version) => version + 1);
  }

  return (
    <div className="dashboard calendar-dashboard">
      <section className="calendar-workspace" aria-labelledby="calendar-workspace-title">
        <header className="calendar-workspace-header">
          <div>
            <p className="eyebrow">My attendance</p>
            <h2 id="calendar-workspace-title"><MonthLabel month={selectedMonth} /></h2>
            {overlay ? (
              <p className="calendar-context-name">
                <strong>{overlay.view.sheetTitle}</strong>
                <span>{activeTimesheet?.name}</span>
              </p>
            ) : null}
          </div>
          {overlay ? (
            <SyncStatus state={overlay.syncState} lastCheckedLabel={lastChecked ?? undefined} />
          ) : busy ? (
            <SyncStatus state="syncing" announce={false} />
          ) : null}
        </header>

        <CalendarToolbar
          month={selectedMonth}
          previousMonth={previousMonth}
          nextMonth={nextMonth}
          todayDisabled={!todayAvailable}
          syncing={busy}
          onSync={syncNow}
          onMonthChange={(month) => {
            setChosenTimesheet(null);
            setSelectedDate(null);
            setSelectedTrigger(null);
            setSelectedMonth(month);
          }}
          onToday={(trigger) => {
            if (todayDate) {
              setSelectedDate(todayDate);
              setSelectedTrigger(trigger);
            }
          }}
        />

        {overlay && todayDate === null ? (
          <p className="calendar-timezone-warning" role="status">
            Today is disabled because the spreadsheet timezone could not be determined.
          </p>
        ) : null}

        {overlay ? (
          <p className="calendar-freshness" role="status" aria-live="polite">{overlay.message}</p>
        ) : null}

        {/*
          Always drawn. Every state below is a notice *under* a calendar, never
          instead of one: an empty month, a month still loading, a month nobody
          has created, and a failed check all still show the dates.
        */}
        <MonthCalendar
          month={selectedMonth}
          days={overlay?.view.days ?? []}
          selectedDate={selectedDate}
          todayDate={todayDate}
          localDates={overlay?.localDates ?? EMPTY_DATES}
          attentionDates={overlay?.attentionDates ?? EMPTY_DATES}
          onSelect={(date, trigger) => {
            setSelectedDate(date);
            setSelectedTrigger(trigger);
          }}
        />

        <CalendarStateNotices
          dashboard={dashboard}
          calendar={calendar}
          overlay={overlay !== null}
          candidates={candidates}
          activeTimesheet={activeTimesheet}
          selectedMonth={selectedMonth}
          months={availableMonths(timesheets)}
          onChooseTimesheet={setChosenTimesheet}
          onMonthChange={(month) => {
            setChosenTimesheet(null);
            setSelectedDate(null);
            setSelectedTrigger(null);
            setSelectedMonth(month);
          }}
          onReloadDashboard={reloadDashboard}
          onRetryCalendar={() => setReloadVersion((version) => version + 1)}
        />
      </section>

      <aside className="calendar-side-panel" aria-label="Calendar shortcuts">
        <section className="surface-panel">
          <p className="eyebrow">Quick actions</p>
          <h2>Keep moving</h2>
          <div className="calendar-shortcuts">
            <Link className="action action-primary" href="/timesheets">All timesheets</Link>
            <Link className="action" href="/manage">Managed files</Link>
          </div>
        </section>
      </aside>

      {overlay && selectedDay && selectedTrigger ? (
        <DayQuickPreview
          day={selectedDay}
          statusLabel={statusLabel}
          syncState={overlay.localDates.has(selectedDay.date) ? "saved-locally" : overlay.syncState}
          lastCheckedLabel={lastChecked}
          detailHref={`/files/${activeTimesheet?.id}/attendance/${activeTimesheet?.sheetId}?date=${selectedDay.date}`}
          returnFocusElement={selectedTrigger}
          onClose={() => {
            setSelectedDate(null);
            setSelectedTrigger(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Shared empty sets, so an unloaded month allocates nothing per render. */
const EMPTY_DATES: ReadonlySet<string> = new Set<string>();

interface CalendarStateNoticesProps {
  dashboard: DashboardState;
  calendar: CalendarState;
  /** Whether a month is actually drawn on the grid. */
  overlay: boolean;
  candidates: Timesheet[];
  activeTimesheet: Timesheet | null;
  selectedMonth: string;
  /** Every month an authorized file covers, ascending. */
  months: string[];
  onChooseTimesheet: (timesheet: Timesheet) => void;
  onMonthChange: (month: string) => void;
  onReloadDashboard: () => void;
  onRetryCalendar: () => void;
}

/** The month with a timesheet closest to `month`, or `null` when there is none. */
function nearestMonthWithData(months: readonly string[], month: string): string | null {
  let nearest: string | null = null;
  let best = Number.POSITIVE_INFINITY;

  for (const candidate of months) {
    // Lexicographic distance is meaningless across a year boundary, so compare
    // the months as counts.
    const distance = Math.abs(monthIndex(candidate) - monthIndex(month));
    if (distance < best) {
      best = distance;
      nearest = candidate;
    }
  }

  return nearest;
}

function monthIndex(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return Number.isInteger(year) && Number.isInteger(monthNumber) ? year * 12 + monthNumber : 0;
}

/**
 * Everything said *about* the month, underneath the month.
 *
 * These were four early returns that each replaced the calendar with a notice,
 * which is why an account with no timesheet — or a slow first load, or a failed
 * check — saw no calendar at all. They are now sentences under a grid that is
 * always drawn.
 */
function CalendarStateNotices({
  dashboard,
  calendar,
  overlay,
  candidates,
  activeTimesheet,
  selectedMonth,
  months,
  onChooseTimesheet,
  onMonthChange,
  onReloadDashboard,
  onRetryCalendar,
}: CalendarStateNoticesProps) {
  if (dashboard.status === "failed") {
    return (
      <ErrorNotice
        title={dashboard.message}
        scope="section"
        diagnostic={dashboard.diagnostic}
        onRetry={dashboard.expired ? undefined : onReloadDashboard}
        reauthenticate={dashboard.expired}
      />
    );
  }

  if (calendar.status === "failed") {
    return (
      <ErrorNotice
        title={calendar.message}
        scope="section"
        diagnostic={calendar.diagnostic}
        onRetry={calendar.expired ? undefined : onRetryCalendar}
        reauthenticate={calendar.expired}
      />
    );
  }

  // A month is on screen: it speaks for itself.
  if (overlay) return null;

  if (dashboard.status === "loading" || calendar.status === "loading") {
    return (
      <p className="calendar-freshness" role="status" aria-live="polite">
        Preparing your calendar…
      </p>
    );
  }

  if (candidates.length > 1 && activeTimesheet === null) {
    return (
      <section className="calendar-context-choice" aria-labelledby="context-choice-title">
        <p className="eyebrow"><MonthLabel month={selectedMonth} /></p>
        <h3 id="context-choice-title">Choose a timesheet</h3>
        <p className="page-lede">
          More than one authorized file matches this month, so the app will not guess.
        </p>
        <div className="calendar-context-list">
          {candidates.map((timesheet) => (
            <button
              className="btn-secondary"
              type="button"
              key={`${timesheet.id}:${timesheet.sheetId}`}
              onClick={() => onChooseTimesheet(timesheet)}
            >
              {`Use ${timesheet.name} — ${timesheet.sheetTitle ?? "choose tab"} — ${timesheet.ownerEmail}`}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (activeTimesheet?.sheetId === null) {
    return (
      <StateNotice
        state="no-timesheet"
        scope="section"
        title="Choose your tab for this month"
        detail="This legacy file has no member mapping, so you must choose the correct visible tab."
        action={{ label: "Choose tab", href: `/files/${activeTimesheet.id}/attendance` }}
      />
    );
  }

  /*
   * The arrows step one month at a time, as a calendar's do. This keeps the old
   * "jump to the month that actually has your timesheet" shortcut, which is the
   * thing a person in September with one July file actually wants — it just no
   * longer hijacks the arrows to do it.
   */
  const nearest = nearestMonthWithData(months, selectedMonth);

  return (
    <StateNotice
      state="no-timesheet"
      scope="section"
      title="No timesheet for this month"
      detail="The calendar above is empty because nothing is shared with you for this month. Move to another month, or Sync sheet once the file exists."
      action={
        nearest === null
          ? { label: "Open Timesheets", href: "/timesheets" }
          : {
              label: `Go to ${formatMonthLabel(nearest) ?? nearest}`,
              onClick: () => onMonthChange(nearest),
            }
      }
    />
  );
}

interface CalendarToolbarProps {
  month: string;
  previousMonth: string | null;
  nextMonth: string | null;
  todayDisabled: boolean;
  onMonthChange: (month: string) => void;
  onToday: (trigger: HTMLButtonElement) => void;
  /** Re-reads Google Sheets into this browser's copy and redraws the month. */
  onSync: () => void;
  syncing: boolean;
}

function CalendarToolbar({
  month,
  previousMonth,
  nextMonth,
  todayDisabled,
  onMonthChange,
  onToday,
  onSync,
  syncing,
}: CalendarToolbarProps) {
  return (
    <div className="calendar-toolbar" aria-label="Calendar navigation">
      <button
        type="button"
        className="btn-secondary"
        aria-label="Previous month"
        disabled={previousMonth === null}
        onClick={() => previousMonth && onMonthChange(previousMonth)}
      >
        ←
      </button>
      <strong className="calendar-toolbar-month">{formatMonthLabel(month) ?? month}</strong>
      <button
        type="button"
        className="btn-secondary"
        aria-label="Next month"
        disabled={nextMonth === null}
        onClick={() => nextMonth && onMonthChange(nextMonth)}
      >
        →
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={todayDisabled}
        onClick={(event) => onToday(event.currentTarget)}
      >
        Today
      </button>
      {/*
        Reads the month from Google Sheets again, writes it to this browser's
        copy, and redraws the grid. It is the same path the calendar takes on
        open, run deliberately — so it is also the recovery for a check that
        failed, and the way to pick up a file that was shared a moment ago.
      */}
      <button type="button" className="btn-primary" disabled={syncing} onClick={onSync}>
        {syncing ? "Syncing…" : "Sync sheet"}
      </button>
    </div>
  );
}
