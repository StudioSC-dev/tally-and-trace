import type { ReactNode } from 'react'

interface PageHeaderProps {
  /** The page title, set as the page's one `h1`. */
  title: ReactNode
  /** Shown in the title's place, with no `h1`, while the title is still loading. */
  placeholder?: ReactNode
  /** Test id for the `h1`. */
  titleTestId?: string
  /**
   * The page's own controls (filters, its main action). They sit at the right of the title on one row, and wrap
   * under it, one section gap down, when the row is too narrow.
   */
  children?: ReactNode
  /** On a phone, the controls always take their own full-width row under the title (the dashboard's filters). */
  stackOnPhone?: boolean
}

/**
 * The first block of every page inside `.page` (docs/design-system.md, "Page"): the title on the left in
 * `text-2xl` 600, on a 44px line, with the page's controls grouped on the right.
 */
export function PageHeader({ title, placeholder, titleTestId, children, stackOnPhone = false }: PageHeaderProps) {
  return (
    <header className="page-header" data-testid="page-header">
      <div className="page-title">
        {placeholder ?? (
          <h1 className="text-2xl font-semibold text-ink" data-testid={titleTestId}>
            {title}
          </h1>
        )}
      </div>
      {children && (
        <div className={stackOnPhone ? 'page-actions basis-full sm:basis-auto' : 'page-actions'} data-testid="page-actions">
          {children}
        </div>
      )}
    </header>
  )
}
