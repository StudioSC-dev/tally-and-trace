import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import type { TagRef } from '@tally-trace/shared'
import { TagChip } from './TagChips'

/** The title keeps at least this much of the title line (or all of itself, when shorter) before tags take the rest. */
const TITLE_MIN_PX = 96
/** `gap-1.5` between chips and `gap-2` between the title and what follows it, in px. */
const CHIP_GAP_PX = 6
const LINE_GAP_PX = 8
const MORE_CLASS = 'inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-semibold text-body'

interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** The row's name, on its first line. */
  title: ReactNode
  /** Short marks beside the title (a saving state), on the title line. They never shrink; the title is cut instead. */
  badges?: ReactNode
  /**
   * The record's tags, on the title line after the title: as many as fit beside the title's minimum width, then a
   * "+N" that lists the rest for screen readers and opens a line under the row with their chips.
   */
  tags?: TagRef[]
  /** The one meta line under the title: short facts as sibling spans, cut to one line unless `wrap` is set. */
  meta?: ReactNode
  /**
   * More meta lines, each its own `row-meta` line under the first: content that needs a line of its own
   * (a description, a warning, a decision to make). Each wraps. Falsy entries are skipped.
   */
  details?: ReactNode[]
  /** The row's own controls, in the trailing area before the amount, on the same line as the title and meta. */
  actions?: ReactNode
  /** The figure, right-aligned in its own slot so every row's amount shares one edge. */
  amount?: ReactNode
  /** What the row lists, as `data-row-kind` (for example `limited-entry` or `pending-row`); the `row` hook stays fixed. */
  kind?: string
  /** Let the meta lines wrap rather than cut, for a row with no opener: every fact it carries stays readable. */
  wrap?: boolean
}

/**
 * One line of a `ListSheet` (docs/design-system.md, "Ledger and Row"): square, ruled under
 * every row but the last, with the title and its meta line on the left, then the row's own
 * controls, then the amount. A row with one meta line is 56px between rules on desktop and 64px
 * on a phone. Click, keyboard and ARIA attributes pass through to the `<article>`.
 */
export function Row({ title, badges, tags = [], meta, details = [], actions, amount, kind, wrap = false, className = '', ...rest }: RowProps) {
  const lines = details.filter((d) => d !== undefined && d !== null && d !== false && d !== '')
  const lineRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(tags.length)
  const [open, setOpen] = useState(false)
  const restId = useId()
  const tagKey = tags.map((t) => `${t.id}:${t.name}`).join('|')

  // Fit the tags to the title line: measure every chip (and the widest "+N") on an invisible ruler, keep the title's
  // minimum width and any badges, and show the chips that fit. It runs before paint after every render, so a new
  // title or a badge that appears or goes (a save in flight) refits at once, and again whenever the line resizes.
  const fitRef = useRef<() => void>(() => undefined)
  fitRef.current = () => {
    const line = lineRef.current
    const ruler = rulerRef.current
    if (!line || !ruler) return
    const widths = [...ruler.children].map((c) => c.getBoundingClientRect().width)
    const more = widths.pop() ?? 0
    const titleWidth = line.querySelector<HTMLElement>('[data-row-title]')?.scrollWidth ?? 0
    const badgeWidth = [...line.querySelectorAll<HTMLElement>('[data-row-badge]')].reduce((w, e) => w + e.getBoundingClientRect().width + LINE_GAP_PX, 0)
    const room = line.clientWidth - Math.min(titleWidth, TITLE_MIN_PX) - LINE_GAP_PX - badgeWidth
    let used = 0
    let fits = 0
    for (let i = 0; i < widths.length; i++) {
      const next = used + (i > 0 ? CHIP_GAP_PX : 0) + widths[i]
      const after = i + 1 < widths.length ? CHIP_GAP_PX + more : 0
      if (next + after > room) break
      used = next
      fits = i + 1
    }
    setShown(fits)
  }
  useLayoutEffect(() => fitRef.current())
  useLayoutEffect(() => {
    const line = lineRef.current
    const ruler = rulerRef.current
    if (!line || !ruler || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fitRef.current())
    observer.observe(line)
    observer.observe(ruler)
    return () => observer.disconnect()
  }, [tagKey])

  const hidden = tags.slice(shown)
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
  const cut = wrap ? 'break-words' : 'truncate'
  return (
    <article
      className={`block rounded-none border-b border-line px-4 py-3 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink sm:py-2 ${className}`}
      {...rest}
      data-testid="row"
      data-row-kind={kind}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div ref={lineRef} className="flex min-w-0 items-center gap-2">
            <p data-row-title className="min-w-0 truncate text-base font-semibold text-ink">
              {title}
            </p>
            {badges !== undefined && (
              <span data-testid="row-badges" data-row-badge className="flex shrink-0 items-center gap-1.5">
                {badges}
              </span>
            )}
            {tags.length > 0 && (
              <span data-testid="row-tags" className="relative flex max-w-full shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                {tags.slice(0, shown).map((tag) => (
                  <TagChip key={tag.id} tag={tag} />
                ))}
                {hidden.length > 0 && (
                  <button
                    type="button"
                    className={`${MORE_CLASS} focus-ring hover:border-ink`}
                    data-testid="row-tags-more"
                    aria-expanded={open}
                    aria-controls={restId}
                    aria-label={`${open ? 'Hide' : 'Show'} ${hidden.length} more tag${hidden.length === 1 ? '' : 's'}: ${hidden.map((t) => t.name).join(', ')}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setOpen((o) => !o)
                    }}
                    onKeyDown={stop}
                  >
                    +{hidden.length}
                  </button>
                )}
                <span ref={rulerRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-1.5 whitespace-nowrap">
                  {tags.map((tag) => (
                    <TagChip key={tag.id} tag={tag} measure />
                  ))}
                  <span className={MORE_CLASS}>+{tags.length}</span>
                </span>
              </span>
            )}
          </div>
          {meta !== undefined && (
            <p data-testid="row-meta" className={`${cut} space-x-3 text-xs text-muted`}>
              {meta}
            </p>
          )}
          {open && hidden.length > 0 && (
            <div id={restId} data-testid="row-meta" data-row-tags-rest className="mt-1 flex flex-wrap items-center gap-1.5">
              {hidden.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </div>
          )}
          {lines.map((line, i) => (
            <div key={i} data-testid="row-meta" className="mt-1 break-words text-xs text-body">
              {line}
            </div>
          ))}
        </div>
        {actions !== undefined && (
          <div data-testid="row-actions" className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
        {amount !== undefined && (
          <div data-testid="row-amount" className="shrink-0 text-right">
            {amount}
          </div>
        )}
      </div>
    </article>
  )
}
