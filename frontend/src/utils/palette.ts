/**
 * The tag and category colour palette. The only module outside `index.css` that may hold a hex.
 *
 * The API stores a colour as `#RRGGBB` (the backend rejects anything else), so the picker saves the hex
 * of the swatch it offers, exactly as it always has. How a swatch looks comes from the `--swatch-N` tokens
 * in `index.css`, which differ by theme. A saved colour that is one of these eight hexes is drawn with its
 * swatch's token; any other saved colour is drawn as it was saved. Nothing here rewrites a stored value.
 */

/** The eight swatches the picker offers, in order: swatch N is `--swatch-N` and saves `stored`. */
export const SWATCHES: readonly { n: number; stored: string }[] = [
  { n: 1, stored: '#2563eb' },
  { n: 2, stored: '#7c3aed' },
  { n: 3, stored: '#16a34a' },
  { n: 4, stored: '#f97316' },
  { n: 5, stored: '#db2777' },
  { n: 6, stored: '#0891b2' },
  { n: 7, stored: '#ca8a04' },
  { n: 8, stored: '#dc2626' },
]

/** The colour a new tag or category starts with: the first swatch. */
export const DEFAULT_SWATCH_COLOR: string = SWATCHES[0]?.stored ?? ''

/** How many `--chart-N` tokens the spending breakdown cycles through. */
export const CHART_COUNT = 5

/** The swatch number (1..8) a saved colour is one of, or null when it is not a swatch (any case). */
export function swatchOf(color: string | null | undefined): number | null {
  const wanted = color?.trim().toLowerCase()
  if (!wanted) return null
  return SWATCHES.find((s) => s.stored === wanted)?.n ?? null
}

/** A colour for a token, as CSS: `rgb(var(--name))`, or with an alpha: `rgb(var(--name) / 0.55)`. */
export const tokenColor = (name: string, alpha?: number): string =>
  alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`

/** The colour to draw a saved tag or category colour with: its swatch token, else the saved value, else `fallback`. */
export function displayColor(color: string | null | undefined, fallback: string): string {
  const n = swatchOf(color)
  if (n !== null) return tokenColor(`swatch-${n}`)
  return color?.trim() || fallback
}

/** The fallback for a record with no colour. */
export const NO_COLOR = tokenColor('line-strong')

/** Chart colour `index` (0-based), cycling through `--chart-1..CHART_COUNT`. */
export const chartColor = (index: number): string => tokenColor(`chart-${(index % CHART_COUNT) + 1}`)
