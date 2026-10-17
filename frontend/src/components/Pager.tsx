import { pageItems, pageWindow } from '@tally-trace/shared'

interface PagerProps {
  total: number
  page: number
  pageSize: number
  onPage: (page: number) => void
  /** The accessible name of the nav landmark. */
  label: string
  testId?: string
  disabled?: boolean
}

/**
 * Previous / numbered / Next, with "from–to of total". The markup follows the Transactions
 * page's pager without its per-page select; that page migrates to this one in a follow-up.
 */
export function Pager({ total, page, pageSize, onPage, label, testId, disabled = false }: PagerProps) {
  const view = pageWindow(total, page, pageSize)
  return (
    <nav
      className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between"
      aria-label={label}
      data-testid={testId}
    >
      <p className="text-xs text-muted">
        {view.from}–{view.to} of {total}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(view.page - 1)}
          disabled={disabled || view.page <= 1}
          className="btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        {pageItems(view.pages, view.page).map((item, index) =>
          item === 0 ? (
            <span key={`gap-${index}`} className="px-1 text-muted" aria-hidden="true">…</span>
          ) : (
            <button
              type="button"
              key={item}
              onClick={() => onPage(item)}
              disabled={disabled}
              aria-current={item === view.page ? 'page' : undefined}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition focus-ring ${item === view.page ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken'}`}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPage(view.page + 1)}
          disabled={disabled || view.page >= view.pages}
          className="btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </nav>
  )
}
