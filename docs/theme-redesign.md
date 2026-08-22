# Theme Redesign — Implementation Plan

Branch: `feat/theme-redesign` · Started 2026-07-21 · Living document, updated as phases land.

This is the working plan for the "paper" design-system migration of the web app.
It records what is **already built**, what is **deliberately deferred**, and what
remains before the branch is mergeable. The narrative history lives in
[`HANDOVER.md`](../HANDOVER.md); this file is the forward-looking spec.

---

## 1. Direction & design decisions

The visual direction is ported from `studiosc-portfolio` on `origin/feat/theme-rework`
(not `main` — the direction never merged there). What was taken and what was
deliberately left behind:

| Decision | Rationale |
|---|---|
| **Take the colour scheme, not the layout.** | The portfolio is editorial. This app must read *formal, professional, distinctly financial*. |
| **Two themes swap token *values* via `data-theme`, never class names.** `darkMode` is unset in Tailwind; `dark:` variants must not exist anywhere. | One source of truth per token. A `dark:` variant in this codebase is silently dead code — it does not compile. |
| **Force-dark abandoned.** | ~15:1 contrast is fatiguing over a long ledger session. Both themes are tuned; neither is the "real" one. |
| **Serif is display-only** (page titles, wordmark). Section headings use bold sans (`.subhead`). | Serif everywhere reads as a magazine, not a book of accounts. |
| **Tabular figures set once on `body`**, not per call site. | Nearly every number here is money or a date in a column; Inter's proportional digits visibly drift. `.tnum` remains for anything rendered outside that tree. |
| **Status is a dot + mono label, never a tinted pill.** | `bg-*-500/10` badges glow and pull focus off the figures beside them. |
| **Inputs are underline-only** (`border-b`, transparent background). | A boxed input on a textured page reads as a second card. |
| **Nav active state is an ink underline**, not a tinted fill. | On a ledger the figures carry colour; the chrome must not compete. |
| **Chart paint reads tokens.** The balance series is *ink*, not an accent. | On a ledger the series is the subject; colour is reserved for exceptions. |
| **Paper texture is two inline SVG `feTurbulence` layers** (fine grain + broad mottle) on `z-index:-1` pseudo-elements. | No image files, no requests, nothing to go stale. Disabled under `prefers-reduced-transparency`. |
| **Theme is applied by a blocking inline script in `index.html`** before first paint; state lives on `<html>` and is read via `useSyncExternalStore`. `ThemeContext` deleted. | The theme is genuinely external state — it is set before React mounts. A context would flash the wrong theme. |
| **Mobile (`mobile/`, NativeWind) deliberately untouched.** | Scaffolded, not feature-complete. Porting now means redoing it as screens get built. |

### Anti-signatures being removed

The "an AI built this" read comes from layout signatures, not colour:
`rounded-2xl` cards with hover-glow tinted borders · `bg-*-500/10` accent pills ·
icons in tinted rounded squares · centred headers over left-aligned body.

---

## 2. Status at a glance

Legend: ☑ done · ◐ in progress · ☐ not started

| Phase | Scope | Status |
|---|---|---|
| **A** | Token foundation, fonts, theme switching | ☑ |
| **B** | Full screen sweep — zero `dark:` variants remain | ☑ |
| **C** | Form controls + codemod fallout repair | ☑ |
| **D** | Runtime contrast audit | ☑ |
| **E** | Three-device usability (iPhone / iPad / desktop) | ◐ code fixes landed; hardware verification outstanding |
| **F** | Visual nuances & remaining anti-signatures | ☐ |
| **G** | Guardrails checked into the repo | ☐ |
| **H** | Onboarding flow review | ☐ |

Commits on the branch so far:

- `5560dab` feat(web): add paper design tokens, theme switching, and retoken app chrome
- `e31ad69` feat(web): convert auth screens to paper design system
- `558a6f8` feat(web): convert app screens, charts, and status badges to paper tokens

---

## 3. What is already implemented

### Phase A — Token foundation ☑

- `frontend/src/assets/index.css` — full token set (surfaces `paper`/`surface`/`sunken`,
  hairlines `line`/`line-strong`, text `ink`/`body`/`muted`, status `ok`/`warn`/`info`/`danger`),
  swapped by `data-theme`, with a `prefers-color-scheme` block as the no-JS fallback.
- `frontend/tailwind.config.js` — v4 `@theme inline` adapted to v3: semantic names map
  onto the CSS variables. `darkMode` deliberately unset.
- Fonts via Google Fonts `<link>` with preconnect (Inter / Instrument Serif / JetBrains Mono),
  replacing Montserrat and the CSS `@import`.
- `frontend/src/utils/theme.ts` + `frontend/src/hooks/useTheme.ts` replace the deleted
  `ThemeContext.tsx`. `useTheme()` still returns `{ theme, toggleTheme }`.
- Component layer: `.card`, `.btn-primary`, `.input-field`, `.select-field`, `.badge`,
  `.dot-*`, `.subhead`, `.label`, `.tnum`, `.stat-card`, `.stat-value`.
- Page colour on `<html>` so the texture pseudo-elements are not painted over.

### Phase B — Full sweep ☑

All 16 remaining files converted. **Zero `dark:` variants in any `.tsx`.**
CSS bundle 49.98 kB → 27.81 kB (gzip 8.72 → 6.14) purely from deleting the dark
half of every class pair.

Done via an ordered codemod (pairs → singles → colour-family sweep → shape
signatures → strip surviving `dark:`). Two classes of bug it introduced, both
found and repaired:

1. **Invisible tinted fills.** `bg-blue-500/10 text-blue-700` collapsed to
   `bg-ink text-ink`. 13 sites, 6 files. Fixed by dropping the fill and letting the
   text colour carry status — which is what the badge spec wanted anyway.
2. **~20 silently-dead classes.** `\b` is the wrong boundary for Tailwind classes —
   `-` and `:` are both word boundaries, so `hover:bg-blue-50` became `hover:` and
   `transition-shadow` became `transition-`. An unknown Tailwind class is ignored, so
   **tsc and vite build were green the whole time** while hover states and card
   transitions had quietly stopped existing.

> **Rule for any future codemod here:** anchor on `(?<![\w:-])` / `(?![\w-])`, never `\b`.
> Afterwards, grep for `(hover|focus|focus-within|group-hover|active|disabled):(\s|")`
> and for `transition-(\s|")`.

### Phase C — Form controls ☑

`input.input-field, select.select-field { height: 2.5rem; line-height: 1.5 }` — *element*
selectors, so `textarea` keeps the auto height its `rows` gives it. `.select-field option`
names its own surface (a transparent select renders the popup ink-on-ink in dark).
The date-picker indicator gets an opacity so it does not sit heavy against a hairline.
Verified by measuring boxes in the browser, not by eye.

### Phase D — Runtime contrast audit ☑

The grep-based stray-class audit structurally could not see classes assembled at
runtime from lookup maps and ternaries (`PRIORITY_BADGE` in `WishlistPanel.tsx`,
the `is_expense` ternary in `settings.tsx`) — both carried the invisible-fill bug.

Replaced with a runtime check: for every text-bearing element, read the *computed*
colour, walk up for the effective background, and score WCAG contrast against the
4.5:1 / 3:1 threshold for that element's own size and weight. Origin-agnostic, so
maps, ternaries and template literals are all covered. Clean in both themes across
login, dashboard, accounts, transactions, allocations, forecast, settings, the
wishlist tab and the add-item dialog.

---

## 4. Remaining deliverables

### Phase E — Three-device usability ☐ (the priority)

**Targets:** iPhone 17 (Safari + Firefox) · iPad Pro M4 (Safari + Firefox) · Desktop PC
(Zen Browser primary, but browser-agnostic).

Note both iOS browsers are WebKit shells — a Safari-iOS fix is a Firefox-iOS fix.
The real second engine is Gecko/Blink on the desktop.

**E1 — Viewport & safe areas** ☑ *(fixed 2026-08-22)*

- ☑ **`100vh` → `100dvh`.** iOS Safari's dynamic toolbar makes `100vh` resolve to the
  *expanded* viewport, so a full-height box is taller than what is visible: the bottom
  clips and the scroll jumps on every toolbar collapse. Fixed centrally rather than at
  the 15 call sites — `minHeight.screen` / `height.screen` are redefined to `100dvh` in
  `tailwind.config.js`, and `body` / `#root` in `index.css` carry a `vh`→`dvh` fallback
  pair. Verified in the built CSS: `.min-h-screen{min-height:100dvh}`.
- ☑ **Nav status-bar inset.** `index.html` asked for a translucent status bar
  (`black-translucent`) while the fixed top nav had no `env(safe-area-inset-top)`
  padding, so installed to the Home Screen the nav rendered under the clock. Nav now
  carries `.safe-area-top`. **`<main>`'s offset had to move with it** — the old flat
  `pt-20` gave 16 px of slack over a 64 px bar, which a ~59 px notch inset swallows
  whole; it is now `.below-nav` (`calc(5rem + env(safe-area-inset-top))`).
- ☑ **Modal backdrops** now use `.modal-backdrop`, which pads with
  `max(1.5rem, env(safe-area-inset-*))` so no action row lands under the home indicator.

**E2 — Touch input** ◐

- ☑ **16 px floor on form controls.** Two `input-field text-sm` (14 px) fields on the
  *login screen* triggered iOS Safari's focus zoom, which never zooms back out.
  Enforced on the controls themselves under `@media (pointer: coarse)` rather than by
  auditing call sites — a stray `text-sm` on an input is otherwise a silent regression
  nothing in the build catches. The two call sites were cleaned up as well.
- ☑ **`-webkit-tap-highlight-color: transparent`** under `pointer: coarse` — the default
  blue flash was the one piece of unthemed colour left on mobile.
- ☐ **Tap-target audit** against the 44 × 44 pt floor. `text-xs` is dense in
  `allocations.tsx` (31 sites) and `transactions.tsx` (24); row-level icon buttons are
  the likely failures. BottomNav (`h-16`) is fine. **Needs the device walkthrough.**
- ☐ **Hover-only affordances.** `hover:bg-sunken` and card `transition-colors` do not
  exist on touch; each needs an `active:` / `focus-visible:` equivalent.

**E3 — Modals on small screens** ◐

- ☑ **Scroll chaining fixed, with no JS.** The page used to scroll behind an open
  dialog. The backdrop is `fixed inset-0`, so it already covers the viewport and
  receives every wheel/touch event — the leak was the browser *chaining* the scroll to
  `<body>` once the backdrop hit its end (or whenever its content was shorter than the
  viewport and it never scrolled at all). `overscroll-behavior: contain` on
  `.modal-backdrop` ends the chain. No body scroll-lock hook and no `position: fixed`
  on `<body>`, so the page also keeps its scroll position when the dialog closes.
- ☐ **iOS keyboard trap** — `overflow-y-auto` on the backdrop plus the on-screen
  keyboard can leave the focused field under the keyboard. Needs device verification.
- ☐ **Open decision: the small-screen idiom.** Full-height sheet on iPhone, centred
  dialog from `sm:` up? All nine backdrops now share the `.modal-backdrop` class, so
  this is a one-line change whenever it is made.

**E4 — Wide content**

- Tables in `forecast.tsx` and `index.tsx` are wrapped in `overflow-x-auto` ✓.
- `accounts.tsx` has an `overflow-x-auto` block (lines 323–405) — confirm it scrolls
  inside its own container and does not make the page body scroll horizontally.
- Verify no page body scrolls horizontally at 390 px (iPhone 17 portrait).

**E5 — iPad specifically**

- BottomNav hides at `sm:` (640 px), so iPad gets the desktop top nav in both
  orientations (834 pt portrait / 1194 pt landscape). Confirm the top nav's five
  links + entity switcher + theme toggle + user menu fit at 834 pt without the
  `overflow-x-auto` scroller engaging.
- Split View and Slide Over put the app at ~320–507 pt on an iPad — the mobile
  layout must hold there, not just on the phone.

**E6 — Performance on device**

- The paper texture is two `position: fixed`, full-viewport SVG turbulence layers.
  Measure scroll repaint cost on the iPhone before assuming it is free; if it costs,
  gate the mottle layer behind a min-width or reduce its opacity on small screens.
- `backdrop-blur-sm` on the fixed nav composites on every scroll frame — measure it
  in the same pass.

**E7 — PWA shell** ☑ *(fixed 2026-08-22)*

`index.html` pointed at `/vite.svg` with no `frontend/public/` directory at all, so the
favicon 404'd and Add to Home Screen produced a blank icon — on devices where the Home
Screen is the point. Added `frontend/public/` with `icon.svg`, `icon-maskable.svg` (the
ledger-rule mark, extra padding for the maskable safe zone) and `manifest.webmanifest`
(`display: standalone`, theme/background `#1c1917`), plus `apple-touch-icon` and
`manifest` links. Confirmed all three copy into `dist/`.

Explicitly **not** in scope: a service worker / offline mode — a separate change with
its own cache-invalidation story. The icons are placeholder marks; a designed one can
drop straight in.

### Phase F — Visual nuances ☐

Deferred by the owner during the sweep ("we'll work on the nuances later"):

- Spacing rhythm pass across all screens.
- The `Week / Month / Year` segmented control still carries its pre-migration shape.
- `rounded-full` chips remain in 9 files (`allocations.tsx` 34, `transactions.tsx` 20,
  `accounts.tsx` 10, `index.tsx` 9, `WishlistPanel.tsx` 8, `settings.tsx` 5,
  `verify-email.tsx` 5, `forecast.tsx` 1, `CashflowTimelineCard.tsx` 1) — e.g.
  `Currency: PHP`. A pill is one of the four anti-signatures; these are the last of them.
- Empty-state icon medallions (tinted rounded squares) — same anti-signature.
- Category rows carry two dots (the user's category colour *and* the expense/income
  status dot). Readable but noisy — pick one.

### Phase G — Guardrails in the repo ☐

The audit tooling that caught every bug in phases B–D lived in the session scratchpad
and **is not checked in**. `scratchpad/codemod.py`, `fixpills.py`, `cleanup.py`,
`routes.mjs` and `contrast.mjs` are all gone. Nothing currently stops the next change
from reintroducing an invisible fill.

Deliver:

- `frontend/scripts/contrast.mjs` — the runtime WCAG audit (origin-agnostic; the only
  check that catches runtime-assembled classes).
- `frontend/scripts/routes.mjs` — the stray-palette-class walk over every route in
  both themes.
- An ESLint rule or CI grep rejecting `dark:` variants and raw palette classes
  (`bg-blue-500`, `text-gray-900`, …) in `.tsx`.
- Wire all three into `.github/workflows/ci.yml` as gating steps.

**Blocker:** both scripts drive a real demo-user login against a running API + Postgres.
CI has no such fixture today. Either stand up the Docker Postgres + seeded demo user in
CI, or scope the CI gate to the static lint rule and keep the runtime audits as a
documented local pre-merge step. The static rule is the cheap 80% — recommend shipping
that first.

### Phase H — Onboarding flow review ☐

The 8-step flow is retokenized but its **layout is unreviewed** — it only fires for a
user with `onboarding_completed = false`, so it was never seen during the sweep. It
still carries the centred-header and tinted-icon-square signatures. Needs a walk-through
on a fresh account, on all three devices.

---

## 5. Verification strategy

| Check | Tool | Gates CI? |
|---|---|---|
| Type safety | `tsc --noEmit` | ☑ via `tsc && vite build` |
| Build | `vite build` | ☑ |
| No `dark:` / raw palette classes | grep or ESLint rule | ☐ Phase G |
| No stray palette classes at runtime, both themes | `routes.mjs` (Playwright) | ☐ Phase G |
| WCAG contrast, both themes | `contrast.mjs` (Playwright, computed styles) | ☐ Phase G |
| Visual regression | *none* | ☐ no baseline exists |
| Device behaviour | manual on the three targets | ☐ Phase E |

Current state: `tsc --noEmit` clean, `vite build` passes. Everything below the
build line is either not written or not checked in.

**Known verification gap:** neither tsc nor the build catches this migration's two
characteristic failures — an unknown Tailwind class is silently ignored, and an
invisible `bg-X text-X` pair is structurally valid. Both bugs shipped green. Only the
runtime audits catch them, which is why Phase G is not optional polish.

---

## 6. Gaps, risks & open questions

1. **No visual-regression baseline.** The Playwright scripts are class and contrast
   audits, not screenshot diffs. A layout regression is currently invisible to automation.
2. **Audit scripts are not in the repo** (Phase G) — the guardrails that caught every
   Phase B–D bug cannot currently be re-run by anyone.
3. **`mobile/` (Expo) is untouched** and will diverge further. Decision recorded: port
   it when the screens are built, not before. Phase 3 of the main roadmap.
4. **Onboarding is unreviewed** (Phase H) — a fresh account is the *first* thing a new
   user sees, and it is the least-tested screen on the branch.
5. **CI fixture for the runtime audits** is the Phase G blocker (see above).
6. **Open question — modal idiom on iPhone.** Full-height sheet, or keep the centred
   dialog? All nine backdrops now share the `.modal-backdrop` class, so this is a
   one-line change whenever it is decided.
7. **Open question — service worker.** Out of scope as written. If offline access on
   the phone matters, it needs its own change.
8. ~~**Supabase free-tier pausing.**~~ **RESOLVED 2026-08-22.** Projects pause after
   ~7 days of no activity, and `/health` used to return a static dict that never touched
   the database — so the keep-alive pinger, the only scheduled thing, generated zero
   Supabase activity. Render warmth and Supabase liveness were separate clocks with only
   one being wound. `/health` now runs `SELECT 1`, so the existing monitor keeps both
   alive. Returns 503 on a failed probe; safe because `render.yaml` sets no
   `healthCheckPath` — **adding one later would turn a database outage into a restart
   loop.**
9. **Coupled constant.** `.below-nav` hard-codes the nav's height (`5rem` = `h-16` + air).
   Any change to the nav's height or padding has a partner in that `calc()`.

---

## 7. Suggested sequence

Phase E → Phase G (static rule only) → Phase F → Phase H → Phase G (runtime audits in CI).

Rationale: **E** is what makes the app usable on the devices it is actually used on, and
its two confirmed defects (`100vh`, 14 px inputs) are live bugs rather than polish.
**G's static rule** is a few lines and stops regression while F churns markup.
**F** is cosmetic and safe to do under that net. **H** needs a fresh account, which is
manual setup. **G's runtime half** is last because it is blocked on a CI fixture decision.
