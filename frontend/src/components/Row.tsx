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
/**
 * The "+N" button's box around its chip: the chip's own size on a fine pointer, 44px on a coarse one (`.tap-target`),
 * reaching above and below the title line (`.row-more`). The ruler measures the same box, so the fit holds on both.
 */
const MORE_TARGET_CLASS = 'row-more tap-target inline-flex shrink-0 items-center'

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
   * The record's status (a `StatusText`, which never shrinks or wraps), first on the meta line and outside the text
   * that is cut, so the word always shows in full; the facts after it are cut instead.
   */
  status?: ReactNode
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
  /**
   * Opens the row's record. The title becomes a button named after it, and its hit area stretches over the whole row
   * (`.row-open`), so a click anywhere but the row's own controls opens the record. The row itself is not a control,
   * so its controls (the actions, a detail's buttons, the "+N") are never inside another one.
   */
  onOpen?: () => void
  /** The record cannot be opened for now (a save of its own is in flight): the title says so and shows no pointer. */
  openDisabled?: boolean
}

/**
 * One line of a `ListSheet` (docs/design-system.md, "Ledger and Row"): square, ruled under
 * every row but the last, with the title and its meta line on the left, then the row's own
 * controls, then the amount. A row with one meta line is 56px between rules on desktop and 64px
 * on a phone. A row that opens its record takes `onOpen`; other attributes pass through to the `<article>`.
 */
export function Row({ title, badges, tags = [], meta, status, details = [], actions, amount, kind, wrap = false, onOpen, openDisabled = false, className = '', ...rest }: RowProps) {
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
      className={`block rounded-none border-b border-line px-4 py-3 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:py-2 ${onOpen ? 'row-opener relative' : ''} ${className}`}
      {...rest}
      data-testid="row"
      data-row-kind={kind}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div ref={lineRef} className="flex min-w-0 items-center gap-2">
            {onOpen ? (
              <button
                type="button"
                data-testid="row-open"
                data-row-title
                aria-disabled={openDisabled ? 'true' : undefined}
                className={`row-open min-w-0 truncate text-left text-base font-semibold text-ink ${openDisabled ? 'cursor-default' : ''}`}
                onClick={onOpen}
              >
                {title}
              </button>
            ) : (
              <p data-row-title className="min-w-0 truncate text-base font-semibold text-ink">
                {title}
              </p>
            )}
            {badges !== undefined && (
              <span data-testid="row-badges" data-row-badge className="flex shrink-0 items-center gap-1.5">
                {badges}
              </span>
            )}
            {tags.length > 0 && (
              <span data-testid="row-tags" className="row-tags relative flex max-w-full shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                {tags.slice(0, shown).map((tag) => (
                  <TagChip key={tag.id} tag={tag} />
                ))}
                {hidden.length > 0 && (
                  <button
                    type="button"
                    className={`${MORE_TARGET_CLASS} group focus-ring`}
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
                    <span className={`${MORE_CLASS} group-hover:border-ink`}>+{hidden.length}</span>
                  </button>
                )}
                <span ref={rulerRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-1.5 whitespace-nowrap">
                  {tags.map((tag) => (
                    <TagChip key={tag.id} tag={tag} measure />
                  ))}
                  <span className={MORE_TARGET_CLASS}>
                    <span className={MORE_CLASS}>+{tags.length}</span>
                  </span>
                </span>
              </span>
            )}
          </div>
          {status !== undefined ? (
            <div data-testid="row-meta" className="flex min-w-0 items-center gap-3 text-xs text-muted">
              {status}
              {meta !== undefined && <p className={`${cut} min-w-0 space-x-3`}>{meta}</p>}
            </div>
          ) : (
            meta !== undefined && (
              <p data-testid="row-meta" className={`${cut} space-x-3 text-xs text-muted`}>
                {meta}
              </p>
            )
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
          <div data-testid="row-actions" className="row-actions flex shrink-0 items-center gap-2">
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
