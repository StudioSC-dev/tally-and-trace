# Tally & Trace design system: "Columnar pad"

This is the adopted design system for the Tally & Trace web app. Every screen and
component follows it. The theme layer that carries it lives in
`frontend/src/assets/index.css` (token values) and `frontend/tailwind.config.js`
(utility names); `frontend/e2e/design-tokens.spec.ts` checks the two against this file.

**Feels like:** the accountant's green ledger pad. Flat and ruled, with a bottle-green
spine across the top and a red pencil that comes out only when something is in the red.

**Boldness spent on:** the spine band (the top bar). Everything else is flat tone and rules.

## Brief

- **Subject:** a personal and household money tracker. Amounts are in pesos, and the
  accounts are a payroll account, a savings account, an e-wallet, cash on hand and a
  credit card. It tracks bills, a card statement, allocations and goals.
- **Audience:** the owner and the people they share a household with. They are not
  finance professionals, and they check it on a phone between other things.
- **Primary job:** answer three questions at a glance. How much can we spend? What is
  due? Where did it go? Every number must be easy to read and to compare down a column.
- **Constraints:**
  - Calm, not alarming.
  - Tabular figures everywhere, and a peso sign (₱) from the same face as the digits.
  - Open-licence, self-hosted fonts.
  - Light and dark themes.
  - The seven house bans.
  - Free tier, and no new runtime services.

## Shared rules

1. **Tokens only.**
   - Components use the semantic names (`paper`, `surface`, `sunken`, `line`,
     `line-strong`, `ink`, `body`, `muted`, `accent`, `on-accent`, `spine`, `on-spine`,
     `on-spine-muted`, `ok`, `warn`, `info`, `danger`, `scrim`) and the shape, motion
     and type tokens below. No raw hex, no palette steps (`slate-900`).
   - Colour tokens are RGB channels so Tailwind can add alpha:
     `rgb(var(--x) / <alpha-value>)`.
   - Themes swap values under `data-theme` on `<html>`. There are no `dark:` variants.
2. **Amounts.**
   - Money out is `ink`, and money in is `ok` with a sign.
   - `danger` (red) means only overdue, negative balance or failed.
   - Classes: `amount-out`, `amount-in`, `amount-negative`.
3. **Selection is not an action.** A selected tab, segment or page marker never shares
   the primary button's fill.
4. **Labels are sentence case** in the text face, 13px medium, `muted`. There are no
   tracked capitals, no mono labels, no "A • B • C" meta strings, and no "→" on links.
5. **Radius and elevation encode level.** One value on everything is banned (ban 4).
6. **Lists are one surface with ruled rows,** not one card per row (ban 5).
7. **Motion answers an action.** There is no entrance choreography, and
   `prefers-reduced-motion` reduces every duration to 1ms.
8. **One icon set per app** and no emoji (ban 3).
9. **Touch targets** are at least 44px on coarse pointers.
10. **One face, self-hosted via `@fontsource`,** with ₱ (U+20B1) and true tabular
    figures verified in a browser: IBM Plex Sans (see Type).

## Palette

### Light

| Name | Hex | Role (token) | Notes |
|---|---|---|---|
| Pad | `#E4EAE2` | `paper` (page) | pale ledger green-grey |
| Leaf | `#F2F5F0` | `surface` (panels, list sheets) | lighter than the page |
| Gutter | `#D6DED3` | `sunken` (wells, tracks, chips) | |
| Rule | `#BCC9B8` | `line` (row rules) | |
| Rule strong | `#748870` | `line-strong` (control borders, field underline) | 3.5:1 on leaf |
| Ledger ink | `#16241C` | `ink` (headings, figures) | 14.7:1 on leaf |
| Body | `#2D3B33` | `body` | 10.7:1 |
| Graphite | `#4A5950` | `muted`, `info` | 5.4:1 on gutter |
| Spine | `#22483A` | `accent`, `spine` (primary button, selection rule, top band) | leaf text on spine 9.3:1 |
| Leaf | `#F2F5F0` | `on-accent` (text on the primary button) | 9.3:1 on spine |
| On spine | `#E4EAE2` / `#B5CBBE` | `on-spine`, `on-spine-muted` | 8.4:1 / 6.0:1 |
| Ledger green | `#2A6440` | `ok` | 5.1:1 on gutter |
| Amber pencil | `#875000` | `warn` | 4.8:1 on gutter |
| Red pencil | `#AE2A20` | `danger` (in the red only) | 6.1:1 on leaf |
| Scrim | `#0C130F` | `scrim` (dialog backdrop, at 60%: `bg-scrim/60`; the dialog shadow colour) | the same in both themes |

### Dark

| Role | Hex |
|---|---|
| paper | `#111915` |
| surface | `#17211B` |
| sunken | `#0C130F` |
| line | `#29382F` |
| line-strong | `#5C7563` |
| ink | `#E5EEE7` |
| body | `#C4D1C7` |
| muted, info | `#93A598` |
| accent | `#93CDA9` (on-accent `#111915`, 9.8:1) |
| spine | `#1C3428` (on-spine `#E5EEE7`, 11.3:1; on-spine-muted `#A5BCAE`, 6.6:1) |
| ok | `#8CC6A0` |
| warn | `#E4B062` |
| danger | `#F0968C` |
| scrim | `#0C130F` |

Every text pairing is 6.3:1 or more. `on-accent` and `on-spine-muted` are not in the
original dark proposal; they are derived (the dark paper, and a muted step of on-spine)
and their contrast is given above.

## Type

- **Face:** IBM Plex Sans (IBM, OFL-1.1), `@fontsource/ibm-plex-sans`, weights 400, 500
  and 600. One family. The swap from today's faces is planned (STU-676); the scale
  below already applies.
- **Why:**
  - Its figures are tabular by default, so a column of amounts lines up even where a
    component forgets `tnum`.
  - It has the ₱ glyph.
  - Its squared, mechanical curves read like an adding-machine tape, which suits a ledger.
  - It holds up at 12px.
- **Scale:** Plex runs large, so the base is 15. `body` is `text-base`.

  | Token | Size / line height (px) | Used for |
  |---|---|---|
  | `text-xs` | 12 / 16 | meta, counts |
  | `text-sm` | 14 / 20 | UI text, buttons |
  | `text-base` | 15 / 24 | body |
  | `text-lg` | 18 / 26 | row amounts |
  | `text-xl` | 21 / 28 | panel titles |
  | `text-2xl` | 24 / 32 | page titles |
  | `text-3xl` | 32 / 40 | the leading figure |

  Line heights sit on a 4px grid, so ruled rows keep an even pitch.
- **Weights:** 400 body, 500 labels, 600 titles and figures.

## Spacing

4px base, on the ruled pitch: `4 · 8 · 12 · 16 · 24 · 32 · 48`
(Tailwind 1, 2, 3, 4, 6, 8, 12).

- Rows are 56px (desktop) and 64px (phone) between rules.
- Panel padding: 24.
- Sections are separated by 32 of space, never a line.

## Radius

| Token | Value | Utility | Used on |
|---|---|---|---|
| (none) | 0 | `rounded-none` | rows, the selection rule |
| `--radius-sm` | 4px | `rounded-sm` | buttons, chips |
| `--radius-md` | 6px | `rounded-md` | panels (`.card`, `.stat-card`), list sheets |
| `--radius-lg` | 12px | `rounded-lg` | dialogs |

Fields have no box. They are written on a ruled line (an underline in `line-strong`).

## Elevation

- None on the page: panels separate by tone (leaf on pad) and one rule.
- Dialogs only: `--elev-dialog: 0 20px 40px -18px rgb(12 19 15 / .45)` (utility
  `shadow-dialog`) with `radius-lg`. The shadow is the scrim colour.

## Icons

- **Set:** Phosphor (MIT), Regular weight, 20px, `currentColor`. It replaces every
  inline SVG, emoji and text glyph.
- **Why:** its even, slightly squared strokes match Plex.

## Motion

- **Durations:** `--dur-fast` 100ms (colour; `duration-fast`), `--dur-base` 160ms
  (dialog fade; `duration-base`).
- **Easing:** `--ease: cubic-bezier(.3,0,.2,1)` (`ease-standard`).
- **Where:** no scale, no slide, no hover changes on panels. The selection rule moves
  under the new tab at `dur-fast`.
- **Reduced motion:** 1ms.

## Components

- **Top bar (the spine):**
  - Solid `spine` background.
  - Inside it, `ink`, `body`, `muted` and `line` are re-pointed to the on-spine values.
  - The user menu, a leaf inside the band, gets document values back.
  - The active page is an on-spine underline.
- **Button, four variants:**
  - **primary:** spine fill (`accent`), leaf text (`on-accent`), `radius-sm`, 600.
  - **secondary:** transparent background, `line-strong` outline, ink text.
  - **quiet:** text only.
  - **danger:** red-pencil outline.
  - Height 44px on coarse pointers.
- **Field:** underline only, `line-strong` at rest, spine on focus.
- **Selection rule (tabs and segments):** selected is a leaf background, ink 600, and a
  2px spine rule underneath. Never a fill.
  - Selected (`.seg.is-selected`): `background: surface; color: ink; font-weight: 600;
    box-shadow: inset 0 -2px 0 accent; border-radius: 0`.
  - Unselected (`.seg`): transparent background, `body` colour, weight 500, square; hover
    turns the text `ink`.
  - `SegmentedControl` (a single-select `role="group"` of `aria-pressed` buttons), `Segment`
    (one pressable choice, also used for multi-select toggles such as tags) and `Tabs` /
    `Tab` (`role="tab"`, `aria-selected`) in `frontend/src/components/` apply it. A control
    that marks its choice another way uses `selectionClass` from
    `frontend/src/utils/selection.ts`: the pager's current page (`aria-current="page"`) and
    the Add Account Active switch (`role="switch"`, selected when on).
  - The rule is keyed on the class, never on an ARIA attribute selector.
- **Ledger and Row:**
  - The sheet is leaf, `radius-md`, one `line` border, no shadow.
  - Rows are ruled, radius 0.
  - Amounts are right-aligned on one column edge.
- **Status, as a dot and a word:** 13px 500 in the status colour. "Overdue" and
  negative balances are the only red text.

### Component inventory

The shared components later tickets add. Each is marked planned until its ticket lands.

| Component | Status | What it is |
|---|---|---|
| `Button` | built | the four variants above, one component for every action: `frontend/src/components/Button.tsx` (`buttonClass` styles a link as a button) |
| `SegmentedControl` / `Tabs` | planned | the selection rule, shared by every tab and segment |
| `ListSheet` and `Row` | planned | one leaf sheet with ruled rows, figures on one right edge |
| `StatusText` | planned | status as a dot and a word |
| `EmptyState` | planned | an empty list's message and its one action |
| `Icon` | planned | Phosphor Regular at 20px, `currentColor` |

## Layout concept

Left-aligned, with figures right-aligned on one column edge per list.

```
Dashboard (desktop)
████████████████████████████████████████  ← spine band (nav)
 Dashboard                 [Tag] [W|M|Y]
┌──────────────────────────────────────┐
│ Available cash          ₱296,850.40  │ leaf, flat
│ In  59,750.00   Out  45,921.20   Net │
├──────────────────────────────────────┤ rule
│ BPI Payroll              84,250.40   │ ruled rows, figures
│ HSBC Red (owed)          18,742.30   │ on one right edge
│ GCash                     3,415.75   │
└──────────────────────────────────────┘
```

## Tokens in code

| Token | CSS variable | Tailwind |
|---|---|---|
| colours | `--paper` … `--danger`, `--accent`, `--on-accent`, `--spine`, `--on-spine`, `--on-spine-muted`, `--scrim` | `bg-paper`, `text-ink`, `bg-accent`, `text-on-accent`, `bg-spine`, `text-on-spine`, `text-on-spine-muted`, `bg-scrim/60` … |
| radius | `--radius-sm`, `--radius-md`, `--radius-lg` | `rounded-sm`, `rounded-md`, `rounded-lg` |
| elevation | `--elev-dialog` | `shadow-dialog` |
| motion | `--dur-fast`, `--dur-base`, `--ease` | `duration-fast`, `duration-base`, `ease-standard` |
| type | (Tailwind scale) | `text-xs` … `text-3xl` |
