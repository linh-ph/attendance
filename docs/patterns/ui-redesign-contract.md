# UI Redesign Contract — tokens, primitives, and file ownership

Date: 2026-08-31

Status: Active. Published by task **F1** of
[`docs/plans/active/2026-08-31-attendance-ui-redesign.md`](../plans/active/2026-08-31-attendance-ui-redesign.md),
and refreshed with the Wave 1 additions from **F2** (AppShell), **F5**
(SyncStatus / ErrorNotice / state gallery) and **F6** (WizardShell).

Wave 2 agents: read the **Component entry points** section before you read the
class lists. Most of what Wave 1 built is consumed as a React component, not as
a CSS class, and reaching past the component for its classes is how two screens
end up with two different versions of the same thing.

## How to use this document

This is the **only** file a Wave 1 or Wave 2 agent needs to read to know what
the design system already provides. If something is listed here, use it. If it
is not listed here it does not exist yet — and inventing a second palette, a
second radius scale, or a private button style is a defect, not a shortcut.

Authority above this document, in order:

1. [`docs/specs/2026-08-31-attendance-ui-redesign-design.md`](../specs/2026-08-31-attendance-ui-redesign-design.md)
   — the approved presentation contract. Where a mockup disagrees, the spec wins.
2. [`docs/plans/active/2026-08-31-attendance-ui-redesign.md`](../plans/active/2026-08-31-attendance-ui-redesign.md)
   — task breakdown and the ownership rule.
3. [`CLAUDE.md`](../../CLAUDE.md) — product invariants.

If you need a token or a primitive that is missing, **stop and report it** to
the integrator so it is added here once, rather than added eight times.

## Visual direction — Calm productivity

Dark navy ink on a cool paper canvas. Indigo marks the one thing you are meant
to do next. Three semantic washes carry state, and nothing else does:

- **mint** — successful, synchronized, recorded;
- **amber** — missing, pending, needs attention;
- **red** — destructive, failed, conflict. Nothing else is red.

Component radii sit between 12 and 18 px, borders are one pixel, elevation is
restrained, and the type is a single system-sans / Noto Sans-compatible stack
with tabular numerals on every date, time, duration and count. Spacing is an
8 px grid with denser substeps where compact controls need them.

Two rules bind every surface:

1. **Colour never carries state by itself.** Every state also has text and an
   icon or shape, and an accessible name. The state primitives below draw their
   shape from a pseudo-element, so it survives greyscale, printing, and
   forced-colours; the markup must still supply the words.
2. **Motion stays on `transform` and `opacity`**, and yields to
   `prefers-reduced-motion`. No meaning may depend on animation.

## Stylesheet load order

Registered in [`src/app/layout.tsx`](../../src/app/layout.tsx), which is
**frozen after F1** — no other task edits it. The order is the cascade:

```text
react-day-picker/style.css
tokens.css  →  primitives.css  →  states.css  →  shell.css
            →  login.css  calendar.css  timesheets.css  attendance.css
               manage.css  members.css  wizard.css
```

A per-surface sheet loads last, so a screen can refine a primitive without
having to out-specify it. Every surface sheet is registered already, including
the thin ones: fill yours in, do not add an import.

`loading.css` and `responsive.css` no longer exist. Their rules moved — the
ghosts and the ghost reduced-motion overrides into `states.css`, the global
reduced-motion override into `primitives.css`, and the narrow-viewport rules
into the surfaces that own them.

## File ownership map

One row per file cluster; **the owner is the only task that may edit it.** A
task needing a change elsewhere stops and reports to the integrator.

| Owner | Files |
| --- | --- |
| F1 | `styles/tokens.css`, `styles/primitives.css`, `app/layout.tsx`, all stylesheet splits, `docs/patterns/ui-redesign-contract.md` |
| F2 | `(authenticated)/layout.tsx`, `components/app-shell/*`, `styles/shell.css`, route shells for `/timesheets` `/manage` `/more` |
| F3 | `lib/dashboard/local-store.ts`, `lib/dashboard/local-records.ts`, `lib/cache/*` |
| F4 | `lib/google/sheets-gateway.ts`, `lib/attendance/service.ts`, `lib/attendance/day-state.ts`, `lib/attendance/zone.ts`, `api/files/[fileId]/attendance/[sheetId]/route.ts` |
| F5 | `components/sync-status/*`, `components/api-error-notice.tsx`, `components/loading-ghosts.tsx`, `components/ghost-canvas.tsx`, `styles/states.css` |
| F6 | `components/wizard-shell/*`, `components/setup-progress.tsx`, `styles/wizard.css` |
| S1 | `app/login/*`, `app/page.tsx`, `components/sign-in-button.tsx`, `styles/login.css` |
| S2 | `(authenticated)/dashboard/{page,dashboard-client}.tsx`, `components/month-calendar/*`, `components/day-quick-preview/*`, `components/day-*calendar.tsx`, `components/month-label.tsx`, `styles/calendar.css` |
| S3 | `(authenticated)/timesheets/*`, `open-by-link.tsx`, `recent-files.tsx`, `styles/timesheets.css` |
| S4 | `(authenticated)/files/[fileId]/attendance/**`, `components/{day-summary,work-block-form,timeline-editor}.tsx`, `styles/attendance.css` |
| S5 | `(authenticated)/manage/*`, `components/destination-folder.tsx`, `styles/manage.css` |
| S6 | `(authenticated)/members/*`, `(authenticated)/files/[fileId]/members/*`, `components/{member-inputs,member-rows,roster-picker}.tsx`, `styles/members.css` |
| S7a | `(authenticated)/files/new/*`, `components/month-input.tsx`, `components/google-picker.tsx` |
| S7b | `(authenticated)/files/import/*`, `(authenticated)/files/[fileId]/setup/*` |

Frozen after their wave and unowned by any screen task: `src/auth*.ts`,
`src/lib/auth/*`, `src/lib/access/policy.ts`, `src/lib/google/*` (except F4's
gateway change), `src/lib/workbook/*`, `src/lib/files/*`.

Two placements are worth stating because they are not obvious from the map:

- **`.open-file-panel` is in `timesheets.css`** (S3), not `manage.css`. It is
  the frame around `open-by-link` and `recent-files`, which S3 owns; the
  dashboard merely renders it today.
- **`.card-state*` is in `primitives.css`** (F1), because the dashboard (S2)
  and the managed-files hub (S5) both render managed-file state and must not
  each grow their own pill.

## Breakpoints

The five supported widths. A custom property **cannot** be read inside a
`@media` prelude, so the tokens are the published numbers — for JS, container
queries, and for keeping every hand-written media query on the same five
widths. A media query repeats the literal `rem` value from the third column.

| Token | px | Media query value | Meaning |
| --- | --- | --- | --- |
| `--bp-xs` | 320 | `20rem` | Smallest supported phone |
| `--bp-sm` | 390 | `24.375rem` | Reference phone (390 × 844) |
| `--bp-md` | 768 | `48rem` | Tablet / two columns |
| `--bp-lg` | 1024 | `64rem` | Desktop shell with sidebar |
| `--bp-xl` | 1440 | `90rem` | Wide desktop |

Two narrow-viewport breaks already exist in the stylesheets: `32rem` (section
actions and the folder control go full width) and `40rem` (the day editor's
sticky header and day navigation restack). Keep new work on the five widths
above unless a component genuinely breaks elsewhere.

## Tokens

All defined on `:root` in [`src/app/styles/tokens.css`](../../src/app/styles/tokens.css).
Names marked *retained* exist because rules written before the redesign read
them; prefer the canonical name in new code.

### Canvas and surfaces

| Token | Value | Use |
| --- | --- | --- |
| `--canvas` | `#f6f7fc` | The page ground |
| `--surface` | `#ffffff` | A raised card, panel, or control |
| `--surface-sunken` | `#f0f2f8` | A recessed well inside a surface |
| `--surface-inverse` | `#20284d` | Desktop sidebar / dark chrome |
| `--surface-inverse-ink` | `#ffffff` | Text on `--surface-inverse` (14.3:1) |
| `--surface-inverse-muted` | `#cfd5f0` | Secondary text on it (9.8:1) |
| `--paper` | `var(--canvas)` | *Retained* alias |

### Ink

| Token | Value | On canvas | Use |
| --- | --- | --- | --- |
| `--ink-900` | `#19213b` | 14.9:1 | Body and headings |
| `--ink-700` | `#414b6d` | 8.0:1 | Secondary body copy |
| `--ink-500` | `#5c6580` | 5.4:1 | Labels and muted copy — still AA for normal text |
| `--ink-inverse` | `#ffffff` | — | Text on a dark surface |
| `--ink` | `var(--ink-900)` | — | Alias |

### Lines

| Token | Value | Use |
| --- | --- | --- |
| `--border` | `#e4e7f2` | Decorative separator or card edge. **Never** the sole indicator of a control |
| `--border-strong` | `#7f89a8` | The boundary of an interactive control — 3.5:1 on white, meeting the non-text 3:1 minimum |
| `--line`, `--line-strong` | aliases | *Retained* |

### Primary — indigo

| Token | Value | Use |
| --- | --- | --- |
| `--primary` | `#5868e8` | Selected navigation, primary action fill. White on it: 4.6:1 |
| `--primary-ink` | `#4454d5` | Indigo **as text** on white: 6.0:1. Hover fill |
| `--primary-strong` | `#3d4cc4` | Active / pressed fill |
| `--primary-wash` | `#eef0ff` | Tint behind a selected or focused row |
| `--primary-on` | `#ffffff` | Text on `--primary` |
| `--indigo`, `--indigo-soft` | aliases | Mockup vocabulary |

### Semantic states

| Token | Value | On its wash | Use |
| --- | --- | --- | --- |
| `--success` | `#14745a` | 5.1:1 | Synced, saved, recorded, ready |
| `--success-wash` | `#ddf7ed` | — | Mint fill |
| `--success-line` | `#b6e6d3` | — | Mint border |
| `--warning` | `#875f10` | 5.1:1 | Missing, pending, needs attention |
| `--warning-wash` | `#fff1cc` | — | Amber fill |
| `--warning-line` | `#f0d793` | — | Amber border |
| `--danger` | `#a1263c` | 6.3:1 | Destructive, failed, conflict — nothing else |
| `--danger-wash` | `#ffe7ea` | — | Red fill |
| `--danger-line` | `#f3c3cb` | — | Red border |
| `--neutral` | `#5b6480` | 5.2:1 | No state at all |
| `--neutral-wash` | `#f0f2f7` | — | Neutral fill |
| `--neutral-line` | `#dfe3ee` | — | Neutral border |
| `--mint`, `--amber` | aliases | — | Mockup vocabulary |

### Focus

| Token | Value |
| --- | --- |
| `--focus-ring` | `#2b3ac9` — 8.2:1 on white |
| `--focus-ring-width` | `3px` |
| `--focus-ring-offset` | `2px` |

Every interactive element gets
`outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset);`
on `:focus-visible`. Never remove an outline without replacing it with an
equally visible one.

### Radii

| Token | Value | Use |
| --- | --- | --- |
| `--radius-xs` | `0.5rem` / 8px | A chip inside a dense row |
| `--radius-sm` | `0.625rem` / 10px | Compact controls |
| `--radius-control` | `0.75rem` / 12px | Inputs and buttons |
| `--radius-card` | `0.9375rem` / 15px | Cards and rows |
| `--radius-panel` | `1.125rem` / 18px | Page-level panels |
| `--radius-pill` | `999px` | Pills |
| `--radius` | `var(--radius-panel)` | *Retained* alias |

### Spacing — 8 px grid with denser substeps

| Token | Value | px |
| --- | --- | --- |
| `--space-3xs` | `0.125rem` | 2 |
| `--space-2xs` | `0.25rem` | 4 |
| `--space-xs` | `0.5rem` | 8 |
| `--space-sm` | `0.75rem` | 12 |
| `--space-md` | `1rem` | 16 |
| `--space-lg` | `1.5rem` | 24 |
| `--space-xl` | `2rem` | 32 |
| `--space-2xl` | `3rem` | 48 |
| `--spacing` | `var(--space-md)` | *Retained* alias |

### Elevation

| Token | Use |
| --- | --- |
| `--shadow-xs` | A panel that is barely lifted |
| `--shadow-sm` | Default card rest state |
| `--shadow-md` | Card hover |
| `--shadow-lg` | Popover, bottom sheet, login hero |
| `--shadow-primary` | The glow under a primary action |
| `--shadow` | `var(--shadow-md)` — *retained* alias |

### Type

| Token | Value |
| --- | --- |
| `--font-ui` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans", Roboto, "Helvetica Neue", "Noto Sans JP", Arial, sans-serif` |
| `--font-numeric` | `var(--font-ui)` — *retained*. Numbers stay in the UI family; alignment comes from `tabular-nums`, not from a second face |
| `--font-mono` | Code and provider diagnostics only |

| Size token | Value | px |
| --- | --- | --- |
| `--text-2xs` | `0.6875rem` | 11 |
| `--text-xs` | `0.75rem` | 12 |
| `--text-sm` | `0.8125rem` | 13 |
| `--text-base` | `0.9375rem` | 15 |
| `--text-md` | `1rem` | 16 |
| `--text-lg` | `1.125rem` | 18 |
| `--text-xl` | `1.375rem` | 22 |
| `--text-2xl` | `clamp(1.5rem, 1.15rem + 1.5vw, 2rem)` | 24–32 |
| `--text-display` | `clamp(2rem, 1.4rem + 3vw, 3rem)` | 32–48 |

Line height: `--leading-tight` 1.15, `--leading-snug` 1.3,
`--leading-normal` 1.5, `--leading-relaxed` 1.6.

Tracking: `--tracking-tight` `-0.03em`, `--tracking-snug` `-0.015em`,
`--tracking-label` `0.1em`.

Weight: `--weight-medium` 500, `--weight-semibold` 600, `--weight-bold` 700,
`--weight-black` 800.

### Motion

| Token | Value |
| --- | --- |
| `--duration-fast` | `120ms` |
| `--duration` | `180ms` |
| `--duration-slow` | `260ms` |
| `--ease` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-out` | `cubic-bezier(0.33, 1, 0.68, 1)` |

### Layout metrics

| Token | Value | Use |
| --- | --- | --- |
| `--content-max` | `72rem` | `main` width cap |
| `--reading-max` | `46ch` | Prose measure |
| `--app-bar-height` | `3.75rem` | A 44 px target plus its surround. The day editor's sticky header offsets by this. **F2 re-declares it as `0rem` on the wide shell — see below** |
| `--sidebar-width` | `15rem` | Desktop shell (F2) |
| `--bottom-nav-height` | `3.875rem` | Mobile shell (F2) |
| `--touch-target` | `2.75rem` / 44px | WCAG 2.2 pointer minimum |
| `--safe-top`, `--safe-bottom`, `--safe-left`, `--safe-right` | `env(safe-area-inset-*, 0px)` | Notch and home-indicator padding |

### Stacking order

`--z-sticky` 5 · `--z-app-bar` 10 · `--z-popover` 20 · `--z-sheet` 40 ·
`--z-toast` 60. Do not write a raw `z-index`.

### Shell overrides — read the tokens, never hard-code a bar height

F2 re-points two of these tokens by viewport, because the compact shell and the
wide shell are different chrome, not the same chrome resized. A screen that
reads the tokens gets both layouts for free; a screen that hard-codes a pixel
height is wrong on one of them.

- **`--app-bar-height` is re-declared as `0rem`** on `main` inside the
  `min-width: 64rem` block. The sticky brand bar exists **only on the compact
  shell** — the wide shell puts navigation in the sidebar, so there is no top
  bar to clear. Anything that offsets from the top of the page must use
  `var(--app-bar-height)` and will then correctly collapse to `0` on desktop.
  The day editor's `.attendance-header` already does exactly this.
- **`.app-main .sticky-actions` is lifted** by `--bottom-nav-height` plus
  `--safe-bottom` on the compact shell, so a sticky Save row clears the mobile
  bottom navigation and the home indicator. Use `.sticky-actions`, or
  `PageShell`'s `footer` slot, and this is already handled. **Do not add your
  own bottom offset on top of it** — you will double the gap on a phone.

## Primitives

All in [`src/app/styles/primitives.css`](../../src/app/styles/primitives.css),
owned by F1. Each has designed hover, focus and active states and a visible
focus ring.

### Page rhythm

| Class | What it is |
| --- | --- |
| `.dashboard` | Vertical stack of page sections. Used by the dashboard **and** every wizard |
| `.section-header` | Section title row with a bottom rule; its `h2` is the uppercase micro-label |
| `.section-actions` | Right-aligned action cluster in a section header; goes full width below `32rem` |

### Type

`.eyebrow` (uppercase indigo micro-label) · `h1` (element rule, `--text-2xl`) ·
`.page-lede` (muted intro capped at `--reading-max`).

### Buttons

| Class | What it is |
| --- | --- |
| `button` / `.btn` | **Primary by default** — indigo fill, white text, 44 px minimum height |
| `.btn-secondary` | Bordered and quiet. The default for anything that does not commit |
| `.btn-ghost` | No chrome until hovered. A tertiary action inside dense chrome |
| `.btn-danger` | Destroys or discards. Red appears here and in failure states only |
| `.btn-sm` | 36 px compact variant |
| `.btn-lg` | Roomier primary |
| `.btn-block` | Full width |
| `.action` | The same grammar for a link: bordered secondary |
| `.action-primary` | Promotes `.action` to indigo fill |
| `.google-picker` | Wrapper; its `button` reads as secondary because a picker selects, never commits |

The bare `button` element is styled, so a `<button>` with no class is already a
correct primary action. Give it `.btn-secondary` when it is not one.

### Surfaces

`.surface` (bordered card, `--radius-card`, `--shadow-sm`) ·
`.surface-panel` (page-level container, `--radius-panel`) ·
`.surface-sunken` (recessed well) ·
`.step` (one card in a wizard stack; marked on the element because a wizard
renders its step as the component root, so there is no wrapper to scope
against) ·
`.empty-state` (dashed placeholder).

### Cards

`.card-list` (grid; two columns from `64rem`) · `.card` · `.card-title` ·
`.card-facts` and `.card-fact` (labelled micro-grid) · `.card-fact-numeric`
(tabular) · `.card-detail` (muted tabular sub-line) · `.card-actions`.

### State pills — colour is never alone

Each pill draws a **shape** as well as a wash. The markup supplies the word,
and a pill whose meaning is not already in the surrounding sentence carries its
own accessible name.

| Class | Colour | Shape |
| --- | --- | --- |
| `.state-pill` | Neutral | Filled circle (base) |
| `.state-pill-synced` | Mint | Filled circle |
| `.state-pill-pending` | Amber | Hollow circle |
| `.state-pill-attention` | Amber | Hollow circle |
| `.state-pill-failed` | Red | Square |
| `.state-pill-busy` | Indigo | Horizontal bar |
| `.state-pill-neutral` | Neutral | Dashed hollow circle |

Managed-file state, shared by the dashboard and the managed-files hub:
`.card-state` with `.card-state-ready` (mint, filled circle),
`.card-state-needs-setup` (amber, hollow), `.card-state-needs-repair` (red,
square), and `.card-state-unknown` (neutral, dashed).

Map the spec §5.4 sync vocabulary onto these: `Synced` → synced;
`Saved locally` and `Local storage unavailable` → pending; `Syncing` → busy;
`Offline` and `Remote changes detected` → attention; `Needs attention` →
attention, or failed when the cause is a provider or authentication failure.

### Form fields

| Class | What it is |
| --- | --- |
| `.field` | Column: label, control, hint, error |
| `.field-label` (and `.field > label`) | Uppercase micro-label |
| `.field-control` | The control. **Also matches bare `.field > input`, `> select`, `> textarea`**, so a control cannot go unstyled because a class was forgotten |
| `.field-hint` | Muted helper text |
| `.field-error` | The message named by `aria-describedby`. Carries a leading `!` mark so it is findable without the red |
| `.field-checkbox` | Row layout with a 44 px minimum height |
| `.field-wide` | Spans its grid |

`aria-invalid="true"` on a control paints the red border and wash. Bind the
error with `aria-describedby` in markup — the styling and the announcement are
deliberately driven by the same attribute so they cannot drift apart. Focus the
first invalid field **only after a submitted step fails**, never while typing.

### Skeletons

`.skeleton` reserves the dimensions the real content will take — set
`--skeleton-w` and `--skeleton-h` to the *final* size so nothing shifts when
the content arrives. Presets: `.skeleton-text`, `.skeleton-title`,
`.skeleton-card`, `.skeleton-circle`, and `.skeleton-stack` to space several.
The `skeleton-sweep` animation moves a background position on a fixed-size box,
so it causes no layout, and it stops entirely under reduced motion while the
box still reads as a placeholder.

### Live regions and assistive-only text

`.sr-only` — visually hidden, still announced. Put a polite live region inside
it and status changes are read **without moving focus**.

`.live-region` — its visible sibling for a status line that is also shown;
collapses when empty.

### Sticky action row

`.sticky-actions` — pinned to the bottom at `--z-sticky`, with a blurred canvas
background and bottom padding that already includes `--safe-bottom`, so it
clears a phone's home indicator. `.sticky-actions-top` is the same row pinned
to the top with `--safe-top`.

### Utilities

`.touch-target` (enforces the 44 × 44 minimum) ·
`.touch-target-inset` (grows the hit area around a smaller visible box) ·
`.scroll-x` (wide content scrolls **inside its own box**, never the page —
`html` already sets `overflow-x: hidden`) ·
`.tabular` (tabular numerals; also applied to `time`) ·
`.stack` · `.row`.

### Motion preference

`primitives.css` ends with a global `prefers-reduced-motion` block that
collapses every transition and animation, cancels hover translation, and stops
the skeleton sweep. Anything with a resting position that the collapse would
strand must set that position explicitly — the ghosts in `states.css` are the
worked example.

## Component entry points

Wave 1 shipped three component systems. **Import the component; do not rebuild
it from its classes.** The class lists further down exist so you can read the
CSS, not so you can hand-assemble a second copy of a shell, a status line, or a
wizard.

### Page slots — `src/components/app-shell/page-shell.tsx`

`PageShell` is how a screen gets its frame. It renders the page's **only**
`<main>` and its **only** `<h1>`, so:

- sections inside `children` start at `<h2>`, never `<h1>`;
- do not add your own `<main>` — there is exactly one per page, and `AppShell`
  exports `MAIN_CONTENT_ID` for anything that needs to address it (the skip
  link already does);
- a slot you do not supply is **omitted from the DOM** rather than rendered
  empty, so an unused header action or status area costs nothing;
- the `footer` slot is the place for Save / Back / Continue rows. It is
  already lifted clear of the mobile bottom navigation and the home indicator
  — do not add your own offset on top of it.

Slot classes: `.page-header` `.page-heading` `.page-status`
`.page-header-actions` `.page-content` `.page-footer`. `.page` and
`.app-nav-icon` exist in the markup as hooks and carry no rule.

### Sync and system states — `@/components/sync-status`

Import from `@/components/sync-status`, **except `ErrorNotice`, which is in
`@/components/api-error-notice`**.

- `SyncStatus` is the **only** place the eight sync words from spec §5.4 exist.
  Do not write `Synced`, `Saved locally`, `Syncing`, `Offline`,
  `Needs attention`, `Remote changes detected`, `Local storage unavailable`, or
  `Saved to Google Sheets · local cache unavailable` into a screen by hand — a
  ninth phrasing is a product regression, not a wording preference.
- `StateNotice` covers the fourteen required system states from spec §8.2.
  Reach for it before inventing an empty or error block.
- `ErrorNotice` takes a route's `debug` field through its **`diagnostic` prop**.
  Pass it through; never render a provider diagnostic by hand. The sanitized
  `GoogleErrorDiagnostic` envelope is the only shape allowed in the browser,
  and it is absent entirely when `APP_DEBUG_ERRORS` is off.

### Wizard shell — `@/components/wizard-shell`

Import from `@/components/wizard-shell` **only** — never from a file inside it.
The directory's internals are F6's to rearrange; the index is the contract.

`WizardShell` owns steps, the rail, sticky actions, the review summary, and the
recovery slots. A feature wizard owns its data and validation and nothing else.

## Per-surface class inventory

What each surface sheet contains today. A surface's owner extends its own file
and nothing else.

**`states.css`** (F5) — inline text: `.section-error` `.page-error`
`.card-error` `.google-picker-error` `.open-by-link-error` `.form-status`
`.form-error`. Error notice: `.api-error` `.api-error-title`
`.api-error-detail` `.api-error-page` `.api-error-section` `.api-error-card`.
Sync line: `.sync-status` `.sync-status-detail` `.sync-status-meta`. System
states: `.state-notice` and its modifiers, `.state-skeleton`. Debug
disclosure: `.debug-error` `.debug-error-disclosure` `.debug-error-label`
`.debug-error-badge` `.debug-error-row` `.debug-error-note`. Waiting scene:
`.loading-ghosts` `.loading-ghosts-label` `.ghost-scene`
`.ghost-scene-replaced` `.ghost-canvas` `.ghost` `.ghost-drift` `.ghost-bob`
`.ghost-turn` `.ghost-body` `.ghost-eyes`. Keyframes: `ghost-drift`,
`ghost-bob`, `ghost-turn`, `ghost-blink`.

These are the internals of `SyncStatus`, `StateNotice` and `ErrorNotice` —
consume the components, not the classes.

**`shell.css`** (F2) — chrome: `.app-bar` `.brand` `.brand-mark` `.brand-name`
`.skip-link` `.app-shell` `.app-sidebar` `.app-sidebar-footer` `.app-nav`
`.app-nav-list` `.app-nav-sublist` `.app-nav-item` `.app-nav-group`
`.app-nav-group-label` `.app-nav-link` `.app-nav-icon-box` `.app-nav-label`
`.app-account` `.app-account-mark` `.app-account-copy` `.app-account-label`
`.app-account-email` `.app-sign-out` `.app-main`, plus the `main` container
rule. Page slots: `.page-header` `.page-heading` `.page-status`
`.page-header-actions` `.page-content` `.page-footer`.

`.app-bar-spacer` and `.app-bar-user` were **removed** by F2 — the account
moved into the sidebar footer. Nothing should reference them.

**`login.css`** (S1) — `.page-centered` `.hero` `.hero-split` `.hero-copy`
`.hero-art`. `.hero-art` keeps `object-fit: contain`: the retained
`public/meme.jpeg` must not be cropped to fill, edited, or replaced.

**`calendar.css`** (S2) — `.day-calendar` `.day-calendar-trigger`
`.day-calendar-trigger-label` `.day-calendar-trigger-value`
`.day-calendar-panel` `.day-calendar-weekend` `.day-calendar-entered`
`.day-calendar-chosen` `.day-calendar-source` `.day-multi-calendar`, plus the
`react-day-picker` variable mapping. Day cells are already `--touch-target`
square, and a recorded day is marked by a **dot as well as** its wash.

**`timesheets.css`** (S3) — `.open-file-panel` `.open-by-link`
`.open-by-link-row` `.recent-files` `.recent-files-title` `.recent-files-list`
`.recent-files-tab`.

**`attendance.css`** (S4) — `.attendance` `.attendance-side`
`.attendance-header` `.attendance-month` `.attendance-sheet` `.day-navigation`
`.day-title` `.day-title-weekend` `.day-weekend` `.day-summary`
`.field-derived` `.work-hours` `.work-block` `.work-block-form`
`.work-block-warning` `.work-block-confirm` `.work-block-confirm-actions`
`.timeline` `.timeline-list` `.timeline-row` `.timeline-row-reserved`
`.timeline-label` `.timeline-time` `.timeline-input` `.timeline-reserved`
`.attendance-actions` `.dirty-indicator` `.save-status` `.form-error-actions`
`.conflict-disclosure` `.bulk-apply-open` `.bulk-apply-count`
`.bulk-apply-warning` `.bulk-apply-actions`.

Two product invariants are visible here and must not be re-styled away:
`.field-derived` / `.work-hours` render column H, the sheet's own `=F-G-E`,
which is never typed and never written by a save; and `.timeline-row-reserved`
hatches the two reserved lunch slots rather than merely greying them, so
"spoken for" survives greyscale.

**`manage.css`** (S5) — `.folder-control` `.folder-name`, and the
`.section-header .folder-control` alignment.

**`members.css`** (S6) — `.members` `.member-list` `.member-row` `.member-name`
`.member-email` `.member-status` `.member-status-ready`
`.member-status-pending` `.member-status-invite-failed` `.member-actions`
`.member-inputs` `.member-input-list` `.member-input-row` `.member-form`
`.roster-picker` `.roster-picker-title` `.roster-picker-list`. The three status
classes are the whole vocabulary — `setupStatus` is exactly
`pending` | `ready` | `invite-failed`, and a fourth class here would mean a
fourth value the configuration schema does not have.

**`wizard.css`** (F6) — shell: `.wizard` `.wizard-head` `.wizard-layout`
`.wizard-steps` `.wizard-steps-kicker` `.wizard-progress` `.wizard-progress-seg`
`.wizard-rail` `.wizard-rail-step` `.wizard-rail-link` `.wizard-rail-mark`
`.wizard-rail-copy` `.wizard-rail-label` `.wizard-rail-hint` `.wizard-main`
`.wizard-step-body` `.wizard-step-head` `.wizard-step-title` `.wizard-lede`
`.wizard-banner` `.wizard-actions`. Items: `.wizard-item` `.wizard-item-list`
`.wizard-item-title` `.wizard-item-detail`. Status: `.wizard-status`
`.wizard-status-busy` `.wizard-status-attention`. Review: `.wizard-summary`
`.wizard-summary-title` `.wizard-summary-list` `.wizard-summary-item`
`.wizard-summary-label` `.wizard-summary-value` `.wizard-summary-note`
`.wizard-review`. Progress: `.setup-progress`. Pre-existing and untouched:
`.import-wizard` `.legacy-setup` `.section-note` `.mapping-list` `.mapping-row`
`.mapping-sheet` `.setup-result`.

These are the internals of `WizardShell` — consume the component.

Note: `.timeline-label-suffix` is defined in `primitives.css` beside `.sr-only`
because it is the same visually-hidden treatment; the day editor markup keeps
using its own name.

### Prefix families that span more than one owner

No class name collides across the eleven stylesheets — that was checked
mechanically after the Wave 1 merge. Three **prefixes**, however, are now
shared between owners, and they are easy to confuse at a glance:

| Prefix | Who owns what |
| --- | --- |
| `.page-*` | `.page-lede` is a primitive (F1); `.page-error` is a state (F5); `.page-centered` is login (S1); `.page-header` `.page-heading` `.page-status` `.page-header-actions` `.page-content` `.page-footer` are `PageShell` slots (F2) |
| `.state-*` | `.state-pill*` is a primitive (F1); `.state-notice*` and `.state-skeleton` are F5 components |
| `.skeleton*` | The bare `.skeleton*` presets are primitives (F1). `.state-skeleton` is F5's *scene* built from them — it is not a `.skeleton` variant |

`.wizard-status-busy` and `.wizard-status-attention` (F6) express the same two
ideas as `.state-pill-busy` and `.state-pill-attention` (F1). Both are in use
and neither is wrong, but prefer the `.state-pill` family outside a wizard so
one product does not grow two status vocabularies.

## Accessibility baseline every task inherits

From spec §9. These are already satisfied by the primitives; a screen must not
undo them.

- WCAG 2.2 AA contrast for text and interactive states. The ratios above were
  measured, not estimated — re-measure if you change a colour.
- Every workflow keyboard complete, with a visible focus ring on everything
  focusable.
- The skip link (`.skip-link`, targeting `AppShell`'s exported
  `MAIN_CONTENT_ID`) is already in the shell. It only works while there is
  exactly one `<main>` on the page, which is why `PageShell` renders it and a
  screen must not add another.
- Calendar: arrow-key movement, Enter/Space activation, correct
  selected/today/state announcement, and the **full readable date** exposed
  even though the cell shows a bare day number.
- Popovers and bottom sheets: an accessible name, predictable dismissal, and
  focus restoration.
- Pointer targets at least 44 × 44 CSS px. `button`, `.btn`, `.action`,
  `.field-control`, `.field-checkbox`, `.recent-files-list a`, and the day
  picker's cells already meet this.
- Hover is never the only path to attendance detail or to an action.
- `prefers-reduced-motion` respected; no meaning depends on animation.
- Skeletons reserve final dimensions and stop animating under reduced motion.
- Error text bound to its field with `aria-describedby`; the first invalid
  field receives focus only after a submitted step fails.
- Status messages use live regions and never move focus.
- Time and duration legible at 200% zoom with no horizontal page overflow — a
  timeline scrolls inside its own labelled region.

## What F1 deliberately removed

Recorded so a later reader does not treat these as accidental losses.

- **The "time rail"** — the 3 px accent bar on `.card::before` and the
  `.card:has(.card-state-*)` rules that coloured it. The Swiss / time-rail
  motif is exactly what Calm productivity replaces, and card state is now
  carried by the `.card-state` pill, which has a shape and a word rather than
  only a colour.
- **The monospaced numeric face.** `--font-numeric` now resolves to the UI
  stack, and alignment comes from `tabular-nums`, per the approved
  single-stack direction. `--font-mono` was added for the one place a
  monospace is correct: the sanitized `.debug-error` provider diagnostic.
- **`loading.css` and `responsive.css` as files.** Every rule in them was
  moved, not dropped — verified by diffing the class and custom-property
  inventory before and after the split: zero classes lost, zero tokens lost.

No class name was renamed, so no `.tsx` file needed editing.
