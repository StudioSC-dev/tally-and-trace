/*
  StudioSC design tokens, Tailwind v3 edition.

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
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        // Surfaces — surface is lighter than paper, sunken is darker
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        sunken: 'var(--sunken)',

        // Hairlines
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },

        // Text
        ink: 'var(--ink)',
        body: 'var(--body)',
        muted: 'var(--muted)',

        // Status — small dots and text, never glowing fills
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        info: 'var(--info)',
        danger: 'var(--danger)',
      },
    },
  },
  plugins: [],
}
