import { useEffect, useMemo, useState } from 'react'
import {
  dayEndWire,
  dayStartWire,
  scheduledPageText,
  scheduledThroughNote,
} from '@tally-trace/shared'
import type { ScheduledQuery, ScheduledRange, Transaction } from '@tally-trace/shared'
import { useGetScheduledQuery } from '../../store/api'
import type { CurrencyCode } from '../../utils/currency'
import { UpcomingOccurrenceRow } from './UpcomingOccurrenceRow'
import { UpcomingTransactionRow } from './UpcomingTransactionRow'
import { useOccurrenceDialogs } from './useOccurrenceDialogs'

const TOUCH = 'min-h-[44px]'

interface Props {
  /** The page's search and filters, as the transaction list's own parameter names. */
  filters: ScheduledQuery
  range: ScheduledRange
  pageSize: number
  pageSizes: readonly number[]
  onPageSize: (size: number) => void
  /** The Manila day: a new day is page 1. */
  today: string
  /** The viewer's local day, for a transaction's Planned / Pending label only. */
  localDay: string
  onOpenTransaction: (transaction: Transaction) => void
  /** After an occurrence is recorded or changed: refresh the page's lists. */
  onChanged: () => void
  accountCurrencies?: ReadonlyMap<number, CurrencyCode> | undefined
  /** Whether a search or filter is on, for the empty line. */
  filtered: boolean
}

/**
 * The Transactions page's Scheduled view: everything after Manila's today, from
 * `GET /transactions/scheduled`. The server merges future transactions and unrecorded
 * recurring occurrences by day and pages by cursor, so rows render in the order given.
 * Next keeps a stack of the cursors it has used and Previous pops it; any change of
 * filter, range, page size or day goes back to page 1. Row actions are the Due card's
 * Upcoming rows': a transaction opens the page's action modal, an occurrence has its record
 * buttons, Review and Change date.
 */
export function ScheduledView({
  filters,
  range,
  pageSize,
  pageSizes,
  onPageSize,
  today,
  localDay,
  onOpenTransaction,
  onChanged,
  accountCurrencies,
  filtered,
}: Props) {
  const { openRecord, openChangeDate, openReview, dialogs } = useOccurrenceDialogs(onChanged)
  // The cursors of the pages before this one, kept with the key they were taken under.
  const resetKey = useMemo(
    () => JSON.stringify([filters, range.start, range.end, pageSize, today]),
    [filters, range.start, range.end, pageSize, today],
  )
  const [stack, setStack] = useState<{ key: string; cursors: string[] }>({ key: resetKey, cursors: [] })
  // A new key is page 1 for good: the stack is cleared in this render, so returning to an old key
  // (a search typed and cleared) cannot bring its cursors back.
  if (stack.key !== resetKey) setStack({ key: resetKey, cursors: [] })
  const cursors = useMemo(() => (stack.key === resetKey ? stack.cursors : []), [stack, resetKey])
  const cursor = cursors[cursors.length - 1]
  const args = useMemo<ScheduledQuery>(
    () => ({
      ...filters,
      start_date: dayStartWire(range.start),
      end_date: dayEndWire(range.end),
      limit: pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
    [filters, range.start, range.end, pageSize, cursor],
  )
  const result = useGetScheduledQuery(args, { refetchOnMountOrArgChange: true })
  // The previous page's rows stay up while the next loads; an error replaces them.
  const data = result.isError ? undefined : result.data
  const busy = result.isFetching

  // A page emptied by a post or a move (it was the last row of a later page): go back one page.
  const emptied = result.currentData !== undefined && result.currentData.items.length === 0 && cursors.length > 0
  useEffect(() => {
    if (emptied) setStack({ key: resetKey, cursors: cursors.slice(0, -1) })
  }, [emptied, resetKey, cursors])

  const next = data?.next_cursor ?? null
  const goNext = () => {
    if (next !== null) setStack({ key: resetKey, cursors: [...cursors, next] })
  }
  const goPrevious = () => setStack({ key: resetKey, cursors: cursors.slice(0, -1) })

  const note = scheduledThroughNote(range)
  const pageText = data ? scheduledPageText(cursors.length, pageSize, data.items.length, data.total) : null

  return (
    <div className="space-y-4" data-testid="scheduled-view" aria-busy={busy}>
      {note !== null && (
        <p className="text-xs text-muted" data-testid="scheduled-through-note">{note}</p>
      )}
      {result.isError && (
        <div className="card p-4 space-y-3" role="alert" data-testid="scheduled-error">
          <p className="text-sm text-danger">Could not load the scheduled list.</p>
          <button
            type="button"
            className={`btn-secondary focus-ring ${TOUCH}`}
            onClick={() => void result.refetch()}
            data-testid="scheduled-retry"
          >
            Retry
          </button>
        </div>
      )}
      {data !== undefined && data.items.length === 0 && !busy && (
        <div className="card p-6 text-center" data-testid="scheduled-empty">
          <p className="text-lg font-semibold text-ink">Nothing scheduled</p>
          <p className="text-sm text-muted mt-1">
            {filtered
              ? 'Nothing scheduled matches the current filters in this range. Try adjusting them or reset to see more.'
              : 'No transactions or recurring payments are scheduled in this range.'}
          </p>
        </div>
      )}
      {data !== undefined && data.items.length > 0 && (
        <ul
          className={`card divide-y divide-line transition-opacity ${busy ? 'opacity-60' : ''}`}
          data-testid="scheduled-list"
        >
          {data.items.map((row) =>
            row.kind === 'transaction' ? (
              <UpcomingTransactionRow
                key={`txn:${row.transaction.id}`}
                transaction={row.transaction}
                localDay={localDay}
                onOpen={onOpenTransaction}
                accountCurrencies={accountCurrencies}
              />
            ) : (
              <UpcomingOccurrenceRow
                key={`occ:${row.occurrence.entry_id}:${row.occurrence.occurrence_date}`}
                occurrence={row.occurrence}
                scheduled={data.auto_post_scheduled}
                touch
                onRecord={(action) =>
                  openRecord(row.occurrence.entry_id, row.occurrence.name, row.occurrence.occurrence_date, action)
                }
                onReview={() => openReview(row.occurrence.entry_id, row.occurrence.name)}
                onChangeDate={() =>
                  openChangeDate(
                    row.occurrence.entry_id,
                    row.occurrence.name,
                    row.occurrence.occurrence_date,
                    row.occurrence.effective_date ?? undefined,
                  )
                }
              />
            ),
          )}
        </ul>
      )}
      {data !== undefined && data.total > 0 && (
        <nav
          className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between"
          aria-label="Scheduled pages"
          data-testid="scheduled-pager"
        >
          <p className="text-xs text-muted" data-testid="scheduled-range-text">{pageText}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={goPrevious}
              disabled={cursors.length === 0 || busy}
              className={`btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${TOUCH}`}
              data-testid="scheduled-previous"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={next === null || busy}
              className={`btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${TOUCH}`}
              data-testid="scheduled-next"
            >
              Next
            </button>
            <label className="flex items-center gap-2 text-xs text-muted">
              Per page
              <select
                value={pageSize}
                onChange={(event) => onPageSize(Number(event.target.value))}
                className={`input-field focus-ring !w-auto !py-1 ${TOUCH}`}
                data-testid="scheduled-page-size"
              >
                {pageSizes.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </label>
          </div>
        </nav>
      )}
      {dialogs}
    </div>
  )
}
