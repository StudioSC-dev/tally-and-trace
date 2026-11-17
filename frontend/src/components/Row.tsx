import type { HTMLAttributes, ReactNode } from 'react'

interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** The row's name, on its first line. */
  title: ReactNode
  /** Short marks beside the title (tags, a saving state), on the title line. They never shrink; the title is cut instead. */
  badges?: ReactNode
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
export function Row({ title, badges, meta, details = [], actions, amount, kind, wrap = false, className = '', ...rest }: RowProps) {
  const lines = details.filter((d) => d !== undefined && d !== null && d !== false && d !== '')
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
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-base font-semibold text-ink">{title}</p>
            {badges !== undefined && (
              <span data-testid="row-badges" className="flex shrink-0 items-center gap-1.5">
                {badges}
              </span>
            )}
          </div>
          {meta !== undefined && (
            <p data-testid="row-meta" className={`${cut} space-x-3 text-xs text-muted`}>
              {meta}
            </p>
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
