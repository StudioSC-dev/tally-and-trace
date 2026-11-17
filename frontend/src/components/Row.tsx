import type { HTMLAttributes, ReactNode } from 'react'

interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** The row's name, on its first line. */
  title: ReactNode
  /** The one meta line under the title: short facts as sibling spans, cut to one line. */
  meta?: ReactNode
  /** The figure, right-aligned in its own slot so every row's amount shares one edge. */
  amount?: ReactNode
  /** Anything more (tags, notes, the row's own controls), on lines below; pass nothing when there is none. */
  children?: ReactNode
}

/**
 * One line of a `ListSheet` (docs/design-system.md, "Ledger and Row"): square, ruled under
 * every row but the last, with the title and its meta line on the left and the amount on the
 * right. A row with one meta line and nothing below is 56px between rules on desktop and 64px
 * on a phone. Click, keyboard and ARIA attributes pass through to the `<article>`.
 */
export function Row({ title, meta, amount, children, className = '', ...rest }: RowProps) {
  return (
    <article
      data-testid="row"
      className={`block rounded-none border-b border-line px-4 py-3 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink sm:py-2 ${className}`}
      {...rest}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">{title}</p>
          {meta !== undefined && (
            <p data-testid="row-meta" className="truncate space-x-3 text-xs text-muted">
              {meta}
            </p>
          )}
        </div>
        {amount !== undefined && (
          <div data-testid="row-amount" className="shrink-0 text-right">
            {amount}
          </div>
        )}
      </div>
      {children !== undefined && (
        <div data-testid="row-extra" className="mt-2 space-y-2">
          {children}
        </div>
      )}
    </article>
  )
}
