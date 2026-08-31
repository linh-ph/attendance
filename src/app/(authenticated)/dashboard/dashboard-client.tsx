"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorNotice } from "@/components/api-error-notice";
import { DayQuickPreview } from "@/components/day-quick-preview/day-quick-preview";
import { MonthCalendar } from "@/components/month-calendar/month-calendar";
import { MonthLabel, formatMonthLabel } from "@/components/month-label";
import { StateNotice, StateSkeleton, SyncStatus, type SyncState } from "@/components/sync-status";
import { todayInZone } from "@/lib/attendance/zone";
import type { AttendanceDay } from "@/lib/attendance/model";
import type { AttendanceMonthView, AttendanceRole } from "@/lib/attendance/service";
import { resolveAttendanceCache, type AttendanceCache } from "@/lib/cache/attendance-cache";
import type { CacheContext } from "@/lib/cache/keys";
import { stripAuthorization, type CachedMonthView } from "@/lib/cache/records";
import type { FolderPreference } from "@/lib/dashboard/folder-preference";
import type { ManagedFile, Timesheet } from "@/lib/discovery/file-discovery";
import type { GoogleErrorDiagnostic } from "@/lib/google/errors";

interface DashboardClientProps {
  email: string;
  /** Injected by component tests; production resolves the IndexedDB cache once. */
  cache?: AttendanceCache;
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

export function DashboardClient({ email, cache: cacheProp, now: nowProp }: DashboardClientProps) {
  const [cache] = useState<AttendanceCache>(() => cacheProp ?? resolveAttendanceCache());
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
  }, [activeTimesheet, cache, email, now, reloadVersion]);

  if (dashboard.status === "loading") {
    return (
      <div className="dashboard calendar-dashboard">
        <StateSkeleton label="Preparing your calendar" count={6} variant="card" height="7rem" />
      </div>
    );
  }

  if (dashboard.status === "failed") {
    return (
      <div className="dashboard calendar-dashboard">
        <ErrorNotice
          title={dashboard.message}
          scope="page"
          diagnostic={dashboard.diagnostic}
          onRetry={dashboard.expired ? undefined : reloadDashboard}
          reauthenticate={dashboard.expired}
        />
      </div>
    );
  }

  const months = availableMonths(timesheets);
  const previousMonth = months.filter((month) => month < selectedMonth).at(-1) ?? null;
  const nextMonth = months.find((month) => month > selectedMonth) ?? null;

  if (candidates.length === 0) {
    return (
      <div className="dashboard calendar-dashboard">
        <CalendarToolbar
          month={selectedMonth}
          previousMonth={previousMonth}
          nextMonth={nextMonth}
          todayDisabled
          onMonthChange={(month) => {
            setChosenTimesheet(null);
            setSelectedDate(null);
            setSelectedMonth(month);
          }}
          onToday={() => {}}
        />
        <StateNotice
          state="no-timesheet"
          title="No timesheet for this month"
          action={{ label: "Open Timesheets", href: "/timesheets" }}
        />
      </div>
    );
  }

  if (candidates.length > 1 && activeTimesheet === null) {
    return (
      <div className="dashboard calendar-dashboard">
        <section className="surface-panel calendar-context-choice" aria-labelledby="context-choice-title">
          <p className="eyebrow"><MonthLabel month={selectedMonth} /></p>
          <h2 id="context-choice-title">Choose a timesheet</h2>
          <p className="page-lede">More than one authorized file matches this month, so the app will not guess.</p>
          <div className="calendar-context-list">
            {candidates.map((timesheet) => (
              <button
                className="btn-secondary"
                type="button"
                key={`${timesheet.id}:${timesheet.sheetId}`}
                onClick={() => setChosenTimesheet(timesheet)}
              >
                {`Use ${timesheet.name} — ${timesheet.sheetTitle ?? "choose tab"} — ${timesheet.ownerEmail}`}
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (activeTimesheet?.sheetId === null) {
    return (
      <div className="dashboard calendar-dashboard">
        <StateNotice
          state="no-timesheet"
          title="Choose your tab for this month"
          detail="This legacy file has no member mapping, so you must choose the correct visible tab."
          action={{ label: "Choose tab", href: `/files/${activeTimesheet.id}/attendance` }}
        />
      </div>
    );
  }

  if (calendar.status === "idle" || calendar.status === "loading") {
    return (
      <div className="dashboard calendar-dashboard">
        <StateSkeleton label="Preparing your calendar" count={6} variant="card" height="7rem" />
      </div>
    );
  }

  if (calendar.status === "failed") {
    return (
      <div className="dashboard calendar-dashboard">
        <ErrorNotice
          title={calendar.message}
          scope="page"
          diagnostic={calendar.diagnostic}
          onRetry={calendar.expired ? undefined : () => setReloadVersion((version) => version + 1)}
          reauthenticate={calendar.expired}
        />
      </div>
    );
  }

  const { data } = calendar;
  const todayDate = todayInZone(data.view.spreadsheetTimeZone, now);
  const todayAvailable = todayDate !== null && data.view.days.some((day) => day.date === todayDate);
  const selectedDay = data.view.days.find((day) => day.date === selectedDate) ?? null;
  const statusLabel = selectedDay
    ? data.view.statuses.find((status) => status.code === selectedDay.statusCode)?.labelEn ?? selectedDay.statusCode
    : null;
  const lastChecked = checkedLabel(data.checkedAt, data.view.spreadsheetTimeZone);

  return (
    <div className="dashboard calendar-dashboard">
      <section className="calendar-workspace" aria-labelledby="calendar-workspace-title">
        <header className="calendar-workspace-header">
          <div>
            <p className="eyebrow">My attendance</p>
            <h2 id="calendar-workspace-title"><MonthLabel month={data.view.month} /></h2>
            <p className="calendar-context-name">
              <strong>{data.view.sheetTitle}</strong>
              <span>{activeTimesheet?.name}</span>
            </p>
          </div>
          <SyncStatus
            state={data.syncState}
            lastCheckedLabel={lastChecked ?? undefined}
          />
        </header>

        <CalendarToolbar
          month={selectedMonth}
          previousMonth={previousMonth}
          nextMonth={nextMonth}
          todayDisabled={!todayAvailable}
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

        {todayDate === null ? (
          <p className="calendar-timezone-warning" role="status">
            Today is disabled because the spreadsheet timezone could not be determined.
          </p>
        ) : null}

        <p className="calendar-freshness" role="status" aria-live="polite">{data.message}</p>

        <MonthCalendar
          month={data.view.month}
          days={data.view.days}
          selectedDate={selectedDate}
          todayDate={todayDate}
          localDates={data.localDates}
          attentionDates={data.attentionDates}
          onSelect={(date, trigger) => {
            setSelectedDate(date);
            setSelectedTrigger(trigger);
          }}
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

      {selectedDay && selectedTrigger ? (
        <DayQuickPreview
          day={selectedDay}
          statusLabel={statusLabel}
          syncState={data.localDates.has(selectedDay.date) ? "saved-locally" : data.syncState}
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

interface CalendarToolbarProps {
  month: string;
  previousMonth: string | null;
  nextMonth: string | null;
  todayDisabled: boolean;
  onMonthChange: (month: string) => void;
  onToday: (trigger: HTMLButtonElement) => void;
}

function CalendarToolbar({
  month,
  previousMonth,
  nextMonth,
  todayDisabled,
  onMonthChange,
  onToday,
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
    </div>
  );
}
