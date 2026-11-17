import type { HTMLAttributes } from 'react'

/**
 * One list as one surface (docs/design-system.md, "Ledger and Row"): a leaf sheet with
 * `radius-md`, one `line` border and no shadow. Its children are `Row`s, ruled and square;
 * the sheet clips them to its corners.
 */
export function ListSheet({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-testid="list-sheet" className={`overflow-hidden rounded-md border border-line bg-surface ${className}`} {...rest}>
      {children}
    </div>
  )
}
