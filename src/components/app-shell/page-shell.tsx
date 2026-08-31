import type { ReactNode } from "react";

/**
 * THE PAGE SLOT CONTRACT — every signed-in screen renders into this.
 * ===================================================================
 *
 * `AppShell` owns the chrome (skip link, sidebar / bottom navigation, the
 * focusable content region). `PageShell` owns the frame *inside* that region,
 * so eight screens do not each invent a page header, a heading level, or a
 * sticky footer that clears a phone's home indicator differently.
 *
 * There are exactly three slots:
 *
 * 1. **Page header** — `eyebrow`, `title`, `lede`, plus two optional clusters:
 *    `status` (the F5 `SyncStatus`, or any live status line) and `actions`
 *    (the page-level action cluster; it wraps below the heading on a phone).
 * 2. **Content region** — `children`. Add a rhythm class with
 *    `contentClassName` — `"dashboard"` gives the primitive section stack.
 * 3. **Sticky footer** — `footer`. Optional. It is pinned to the bottom with
 *    the shared `.sticky-actions` primitive, which already carries
 *    `--safe-bottom`, and the shell lifts it clear of the mobile bottom
 *    navigation. Put Save / Back / Continue rows here, nothing else.
 *
 * ```tsx
 * <PageShell
 *   eyebrow="blended-asia"
 *   title="Timesheets"
 *   lede="Open the month you are recording."
 *   status={<SyncStatus … />}
 *   actions={<Link className="action action-primary" href="/files/new">New file</Link>}
 *   contentClassName="dashboard"
 *   footer={<button type="submit">Save</button>}
 * >
 *   <section aria-labelledby="…">…</section>
 * </PageShell>
 * ```
 *
 * Rules a screen must not break:
 *
 * - **`PageShell` renders the page's only `<main>` and its only `<h1>`.** Do
 *   not nest another `main`, and do not render a second level-one heading.
 * - The `main` landmark is named by the heading, so the title must describe the
 *   page. Pass `titleId` when something else has to point at that heading.
 * - Sections inside `children` start at `<h2>`.
 * - Every optional slot is omitted from the DOM when it is not supplied, so an
 *   empty header cluster never reserves space.
 */
export interface PageShellProps {
  /** The page title. Rendered as the page's only `<h1>`. */
  readonly title: ReactNode;
  /** Id of that heading; `main` is named by it. Defaults to `page-title`. */
  readonly titleId?: string;
  /** The uppercase micro-label above the title. */
  readonly eyebrow?: ReactNode;
  /** One muted sentence under the title, capped at the reading measure. */
  readonly lede?: ReactNode;
  /** A status line beside the heading — `SyncStatus`, or any live region. */
  readonly status?: ReactNode;
  /** The page-level action cluster. */
  readonly actions?: ReactNode;
  /** The sticky action row. Omit it and no footer is rendered. */
  readonly footer?: ReactNode;
  /** Extra class on the content region, e.g. `dashboard` for the section stack. */
  readonly contentClassName?: string;
  readonly children: ReactNode;
}

const DEFAULT_TITLE_ID = "page-title";

export function PageShell({
  title,
  titleId = DEFAULT_TITLE_ID,
  eyebrow,
  lede,
  status,
  actions,
  footer,
  contentClassName,
  children,
}: PageShellProps) {
  return (
    <main className="page" aria-labelledby={titleId}>
      <header className="page-header">
        <div className="page-heading">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1 id={titleId}>{title}</h1>
          {lede ? <p className="page-lede">{lede}</p> : null}
        </div>

        {status ? <div className="page-status">{status}</div> : null}
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </header>

      <div className={contentClassName ? `page-content ${contentClassName}` : "page-content"}>
        {children}
      </div>

      {footer ? <div className="page-footer sticky-actions">{footer}</div> : null}
    </main>
  );
}
