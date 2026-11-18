import type { HTMLAttributes } from 'react'

/** The first and last rows' outer corners follow the sheet's inner corner. */
const CORNERS = '[&>:first-child]:rounded-t-[calc(var(--radius-md)_-_1px)] [&>:last-child]:rounded-b-[calc(var(--radius-md)_-_1px)]'

/**
 * One list as one surface (docs/design-system.md, "Ledger and Row"): a leaf sheet with
 * `radius-md`, one `line` border and no shadow. Its children are `Row`s, ruled and square but for the sheet's corners.
 * The sheet clips nothing, so a focused row's keyboard ring (2px, 2px off the row) shows in
 * full; instead the first and last rows round their outer corners to the sheet's inner
 * radius (`radius-md` less the 1px border), which keeps a row's hover or state background
 * inside the sheet's corners.
 */
export function ListSheet({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-testid="list-sheet" className={`rounded-md border border-line bg-surface ${CORNERS} ${className}`} {...rest}>
      {children}
    </div>
  )
}
