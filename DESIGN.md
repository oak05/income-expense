# DESIGN.md — สมุดรายรับรายจ่าย (v2, "clean fintech")

Single source of truth for the web UI. Every value in `app/static/style.css` comes from
the custom properties below — no stray hex codes or magic pixel values in components.
Change a token here *and* in `:root`, never a component one by one.

Direction: clean modern fintech, mobile-first. Cool off-white canvas, white cards with
soft shadows, one strong blue for actions, a deep-navy "balance card" as the hero, green
only for income, red only for expense/danger.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg` | `#F3F5F9` | `#0B1220` | page canvas |
| `--color-surface` | `#FFFFFF` | `#121A2B` | cards, sheets, bars |
| `--color-surface-2` | `#F7F9FC` | `#172136` | inputs, hover fills |
| `--color-surface-3` | `#EBEFF5` | `#1F2A42` | segmented tracks, skeletons, meters |
| `--color-text` | `#0E1726` | `#E6EBF4` | primary text |
| `--color-text-muted` | `#556074` | `#A3AEC2` | labels, secondary text (≥ 4.5:1) |
| `--color-text-subtle` | `#657083` | `#8692A8` | hints, meta (≥ 4.5:1 on surface) |
| `--color-border` | `#E3E8EF` | `#232F47` | card + row dividers |
| `--color-border-strong` | `#CBD3DF` | `#34425F` | input borders |
| `--color-primary` | `#2F5BEA` | `#7393FF` | actions, focus, active nav |
| `--color-primary-hover` | `#2449C8` | `#8EA8FF` | |
| `--color-primary-contrast` | `#FFFFFF` | `#0B1220` | text on primary |
| `--color-primary-soft` | `#E8EEFE` | `#1B2A55` | active nav pill, selected chip wash |
| `--color-accent` | `#F2A93B` | `#F2B656` | highlight stamp, "near budget" meter (non-text) |
| `--color-income` / `-soft` | `#0B7A55` / `#E2F4EC` | `#4FD09A` / `#11301F` | income amounts + icons |
| `--color-expense` / `-soft` | `#C93A3A` / `#FBE9E9` | `#FF8080` / `#3A1A1F` | expense type, danger actions |
| `--color-warning` / `-soft` | `#8A5A00` / `#FDF3DC` | `#F0C060` / `#33290F` | OCR flags, notices |
| `--color-hero` | `#0F1B3D` | `#18285A` | balance card background |
| `--color-hero-text` / `-muted` | `#FFFFFF` / `#B4C3E8` | same | text on hero |
| `--color-hero-good` / `-bad` | `#7CE0B4` / `#FF9E9E` | same | meter fill, negative balance on hero |

Rules: expense amounts in lists use `--color-text` with a "−" sign (red everywhere is
noise); income uses `--color-income` with "+". Red is reserved for over-budget, negative
balances, errors and destructive buttons. Category colours come from the user's data and
are only used as dots, icon tints and chart segments — never for text.

## Typography

- Display/body: `--font-sans` — IBM Plex Sans Thai (bundled, offline), fallback Leelawadee UI / Noto Sans Thai.
- Numbers: same sans with `font-variant-numeric: tabular-nums` (`.num`).
- Mono: `--font-mono` — IBM Plex Mono, only for raw OCR text.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 12 / 1.5 | 500 | badges, meta |
| `--text-sm` | 14 / 1.55 | 400–500 | labels, secondary rows |
| `--text-base` | 16 / 1.6 | 400 | body, inputs (16 avoids iOS zoom) |
| `--text-md` | 18 / 1.5 | 600 | card titles |
| `--text-lg` | 20 / 1.4 | 600 | sheet titles |
| `--text-xl` | 24 / 1.3 | 600 | stat values |
| `--text-2xl` | 32 / 1.2 | 700 | page title (desktop), amount input |
| `--text-3xl` | 40 / 1.15 | 700 | hero balance |

## Spacing

4px base: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 ·
`--space-6` 24 · `--space-8` 32 · `--space-10` 40 · `--space-12` 48 · `--space-16` 64.
Page gutter 16 (mobile) / 24 (≥768) / 32 (≥1280). Card padding 16 / 20 (≥768).

## Shape & depth

Radii: `--radius-sm` 8 · `--radius-md` 12 · `--radius-lg` 16 · `--radius-xl` 24 · `--radius-pill` 999.
Borders 1px `--color-border`. Shadows: `--shadow-1` (cards), `--shadow-2` (raised: FAB,
menus, toast), `--shadow-3` (sheets/dialogs).

## Layout

- Breakpoints: 640 · 768 · 1024 · 1280. Mobile-first: base styles are the phone.
- `< 1024`: top bar (logo · month switcher · more menu) + fixed bottom tab bar with a
  centred FAB ("+" new entry on the ledger, camera on the receipts page). Content clears the tab bar (`--tabbar-h` + safe area).
- `≥ 1024`: 248px sidebar (logo, "+ จดรายการ", views, settings) + main column; tab bar hidden.
- Max content width `--content-max` 1120px.
- Touch targets ≥ 44px.

## Components (all in tokens)

- **Button** `.btn` + `.btn-primary` (primary bg) / `.btn-secondary` (surface-2 bg, border) /
  `.btn-ghost` (transparent) / `.btn-danger` (expense outline). Height 44 (`.btn-sm` 36).
  Hover darkens/fills, focus = 2px `--color-primary` ring offset 2, disabled 45% opacity.
- **Icon button** `.icon-btn` 44×44 hit area, 20px icon, radius-pill hover fill.
- **Input** 44px min-height, `--color-surface-2` fill, `--color-border-strong` border, radius-md;
  focus border + 3px `--color-primary-soft` ring; invalid uses expense border + soft fill.
- **Segmented control** `.segmented` radio group on `--color-surface-3` track, selected
  segment = surface + shadow-1; type switch tints expense/income.
- **Chip** `.chip` pill 36px, category dot; selected = primary-soft fill + primary border.
- **Card** `.card` surface, radius-lg, shadow-1, border.
- **Hero card** `.hero` `--color-hero` bg, balance, spend meter, cumulative balance.
- **Stat card** `.stat` icon tile + label + value + comparison.
- **Transaction row** `.tx-row` 40px tinted icon tile (category colour, direction arrow), title,
  meta line, right-aligned amount. Grouped by day with a sticky day header + day-end balance.
- **Sheet** `dialog.sheet` bottom sheet < 768, centred modal ≥ 768.
- **Nav** `.side-nav` (desktop) / `.tabbar` (mobile); active = primary-soft pill + primary text.
- **Switch** `.switch` 40×24 track (border-strong → primary when on), knob = surface + shadow-1; used for "รวมยอด" on receipts.
- **Dropzone** dashed border-strong, primary-soft icon disc; `.over` = primary border + primary-soft fill.
- **Slip card** card with 64/72/104px thumbnail; on phones the fields run full width under the thumbnail.
- **Receipt summary** card (sticky right column ≥ 1024); below that a fixed bar above the tab bar (count, total, save).
- **Banner** `.banner-ok / -warn / -error` soft fill + matching text colour, icon first.
- **Toast** surface-inverse, shadow-2, sits above the tab bar.
- States everywhere: hover, focus-visible, active, disabled, loading (skeleton), empty, error.

## Motion

`--dur-1` 150ms (hover), `--dur-2` 220ms (sheet, toast), `--dur-3` 300ms (meters);
easing `--ease` `cubic-bezier(.2,.8,.2,1)`. All disabled under `prefers-reduced-motion`.

## Voice & imagery

Thai, short, friendly and direct ("จดรายการ", "ยังไม่มีรายการ — เริ่มจดรายการแรกได้เลย").
No emoji as UI. Icons: one inline SVG sprite (`/icons.svg`), 24 grid, 2px stroke, round caps.
