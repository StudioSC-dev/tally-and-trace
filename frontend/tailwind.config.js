/*
  Tally & Trace design tokens (Direction B, "Columnar pad"; docs/design-system.md),
  Tailwind v3 edition.

  The portfolio declares these with v4's `@theme inline`; v3 has no such block,
  so the semantic names are mapped onto CSS variables here instead. The values
  themselves live in src/assets/index.css and are swapped by `data-theme`.

  There is deliberately no `darkMode` setting: themes swap token *values*, not
  class names, so `dark:` variants must not exist anywhere in this codebase.
  Anything referencing a palette step (slate-900, blue-500) is drift.
*/
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // `.stat-card` is a design-system panel (index.css) that no markup uses yet; keep it in the build.
  safelist: ['stat-card'],
  theme: {
    extend: {
      /*
        `min-h-screen` / `h-screen` are redefined to `dvh` rather than fixed at
        each of the 15 call sites. iOS Safari's dynamic toolbar makes `100vh`
        resolve to the expanded viewport, so a `100vh` box is taller than what
        is visible — the bottom clips and the scroll jumps whenever the toolbar
        collapses. `dvh` tracks the visible box instead.

        No `vh` fallback is emitted here (Tailwind writes one declaration per
        utility); `body` and `#root` in index.css carry the fallback pair, and
        every browser these ship to supports `dvh` (Safari 15.4+, Firefox 101+,
        Chrome 108+).
      */
      minHeight: {
        screen: '100dvh',
      },
      height: {
        screen: '100dvh',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        // Surfaces — surface is lighter than paper, sunken is darker
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        sunken: 'rgb(var(--sunken) / <alpha-value>)',

        // Hairlines
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },

        // Text
        ink: 'rgb(var(--ink) / <alpha-value>)',
        body: 'rgb(var(--body) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',

        // Actions and the band — the spine green
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'on-accent': 'rgb(var(--on-accent) / <alpha-value>)',
        spine: 'rgb(var(--spine) / <alpha-value>)',
        'on-spine': 'rgb(var(--on-spine) / <alpha-value>)',
        'on-spine-muted': 'rgb(var(--on-spine-muted) / <alpha-value>)',

        // Status — small dots and text, never glowing fills
        ok: 'rgb(var(--ok) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',

        // The dialog backdrop, used with an alpha (`bg-scrim/60`)
        scrim: 'rgb(var(--scrim) / <alpha-value>)',
      },
      /*
        Columnar pad type scale (docs/design-system.md): IBM Plex Sans runs
        large, so the base is 15. Line heights sit on a 4px grid so ruled rows
        keep an even pitch. 12/16 · 14/20 · 15/24 · 18/26 · 21/28 · 24/32 · 32/40.
      */
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.625rem' }],
        xl: ['1.3125rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['2rem', { lineHeight: '2.5rem' }],
      },
      // Radius encodes level: buttons and chips, panels, dialogs. Rows stay square.
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      // Dialogs are the only raised layer.
      boxShadow: {
        dialog: 'var(--elev-dialog)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease)',
      },
    },
  },
  plugins: [],
}
