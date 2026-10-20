import { useEffect, useId, useMemo, useState } from 'react'
import {
  LIMITED_ROWS,
  RECURRING_ACTION_LABELS,
  PENDING_POST_LABELS,
  dueRecurringRows,
  duePendingRows,
  formatEntryDate,
  pendingLinkIds,
  transactionDescription,
} from '@tally-trace/shared'
import type { DueEntryRow, DueMissedRow, DuePendingRow, RecurringAction, Transaction } from '@tally-trace/shared'
import { useGetDashboardSnapshotQuery, useGetTransactionsQuery } from '../../store/api'
import { formatCurrency } from '../../utils/currency'
import { MarkPaidDialog } from '../MarkPaidDialog'

/**
 * "Due and overdue": every recurring occurrence the caller can record and every pending
 * transaction that is overdue or tied to the schedule, in one place. Recurring rows come
 * from the dashboard snapshot (the same cache the dashboard fills; no new endpoint);
 * pending rows from two transaction queries (the next 30 days, and the rows missed
 * occurrences link, whatever their date). The merge, the dedup and the labels live in
 * `@tally-trace/shared` (`dueSection.ts`).
 */

const WINDOW_DAYS = 30
const PAGE = 1000

const ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'due-mark-paid',
  mark_received: 'due-mark-received',
  charged: 'due-charged',
  posted: 'due-posted',
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface Props {
  /** The viewer's calendar day (`YYYY-MM-DD`). */
  today: string
  /** Post a pending transaction: the page's own posting flow. */
  onPost: (transaction: Transaction) => void
  /** After a recurring occurrence is recorded: refresh the page's lists. */
  onChanged: () => void
}

interface RecordTarget {
  entryId: number
  name: string
  occurrenceDate: string
  action: RecurringAction | undefined
}

const buttonClass =
  'border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors focus-ring'
const primaryButtonClass =
  'bg-ok px-2.5 py-1 text-xs font-semibold text-paper hover:bg-ok disabled:opacity-50 transition-colors focus-ring'

export function DueAndOverdueSection({ today, onPost, onChanged }: Props) {
  const panelId = useId()
  const [open, setOpen] = useState(true)
  const [target, setTarget] = useState<RecordTarget | null>(null)
  // Pages of the window query before the one on screen ("Load more").
  const [earlier, setEarlier] = useState<Transaction[]>([])
  const [offset, setOffset] = useState(0)

  const { data: snapshot, isLoading: snapshotLoading, error: snapshotError } = useGetDashboardSnapshotQuery({})
  const windowQuery = useGetTransactionsQuery({
    is_posted: false,
    end_date: `${addDays(today, WINDOW_DAYS)}T23:59:59`,
    limit: PAGE,
    offset,
  })
  const linkIds = useMemo(() => (snapshot ? pendingLinkIds(snapshot) : []), [snapshot])
  const linkedQuery = useGetTransactionsQuery(
    { ids: linkIds, is_posted: false, limit: Math.min(Math.max(linkIds.length, 1), PAGE) },
    { skip: linkIds.length === 0 },
  )

  const windowItems = windowQuery.currentData?.items
  const windowTxns = useMemo(() => [...earlier, ...(windowItems ?? [])], [earlier, windowItems])
  const linkedTxns = useMemo(() => (linkIds.length > 0 ? (linkedQuery.currentData?.items ?? []) : []), [linkIds, linkedQuery.currentData])
  const hasMore = windowQuery.currentData?.has_more === true

  // The day rolling over restarts the window.
  useEffect(() => {
    setEarlier([])
    setOffset(0)
  }, [today])

  const recurring = useMemo(() => (snapshot ? dueRecurringRows(snapshot, today) : []), [snapshot, today])
  const pending = useMemo(
    () => (snapshot ? duePendingRows(windowTxns, linkedTxns, snapshot, today) : []),
    [snapshot, windowTxns, linkedTxns, today],
  )
  const count = recurring.length + pending.length
  const loading = snapshotLoading || windowQuery.isLoading

  const loadMore = () => {
    if (!windowItems) return
    setEarlier((prev) => [...prev, ...windowItems])
    setOffset((prev) => prev + PAGE)
  }

  const record = (row: DueEntryRow | DueMissedRow, action: RecurringAction | undefined) =>
    setTarget({
      entryId: row.entryId,
      name: row.name,
      occurrenceDate: row.kind === 'missed' ? row.oldest : row.occurrenceDate,
      action,
    })

  const actionButtons = (row: DueEntryRow | DueMissedRow) =>
    row.actions.map((action, index) => (
      <button
        key={action}
        type="button"
        onClick={() => record(row, action)}
        className={index === 0 ? primaryButtonClass : buttonClass}
        data-testid={ACTION_TEST_IDS[action]}
      >
        {RECURRING_ACTION_LABELS[action]}
      </button>
    ))

  const pendingRow = (row: DuePendingRow) => {
    const txn = row.transaction
    return (
      <li
        key={row.key}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="pending"
        data-view={row.view}
        data-source={`transaction:${txn.id}`}
      >
        <div>
          <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Pending transaction'}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(row.date)} · Pending
            {row.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
          </p>
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(txn.amount, txn.currency)}</p>
          {row.action && (
            <button
              type="button"
              onClick={() => onPost(txn)}
              className={primaryButtonClass}
              data-testid={row.action === 'posted' ? 'due-posted' : 'due-mark-posted'}
            >
              {PENDING_POST_LABELS[row.action]}
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
    <section className="card" data-testid="due-section" data-limited-rows={LIMITED_ROWS} aria-labelledby={`${panelId}-title`}>
      <h2 id={`${panelId}-title`} className="text-lg font-semibold text-ink">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-ring"
          data-testid="due-section-toggle"
        >
          <span>Due and overdue</span>
          <span className="badge" data-testid="due-count">{loading ? '…' : count}</span>
        </button>
      </h2>
      {open && (
        <div id={panelId} className="border-t border-line">
          {snapshotError && (
            <p className="px-4 py-3 text-sm text-danger" role="alert">Could not load what is due.</p>
          )}
          {!loading && !snapshotError && count === 0 && (
            <p className="px-4 py-3 text-sm text-muted" data-testid="due-empty">Nothing due or overdue in the next 30 days.</p>
          )}
          {count > 0 && (
            <ul className="divide-y divide-line" data-testid="due-list">
              {recurring.map((row) => {
                if (row.view === 'limited') {
                  return (
                    <li
                      key={row.key}
                      className="flex items-start justify-between gap-3 px-4 py-3"
                      data-testid="due-row"
                      data-kind="recurring"
                      data-view="limited"
                    >
                      <div>
                        <p className="text-sm font-medium text-ink">{row.name}</p>
                        <p className="text-xs text-muted">{formatEntryDate(row.date)} · Shared item</p>
                      </div>
                      {row.overdue && <span className="badge badge-danger flex-shrink-0" data-testid="due-overdue">Overdue</span>}
                    </li>
                  )
                }
                if (row.kind === 'missed') {
                  return (
                    <li
                      key={row.key}
                      className="flex items-start justify-between gap-3 px-4 py-3"
                      data-testid="due-row"
                      data-kind="missed"
                      data-view={row.view ?? 'full'}
                      data-source={`budget_entry:${row.entryId}`}
                    >
                      <div>
                        <p className="text-sm font-medium text-ink">{row.name}</p>
                        <p className="text-xs text-warn" data-testid="due-missed-text">{row.text}</p>
                      </div>
                      <div className="flex flex-shrink-0 flex-wrap justify-end gap-2">{actionButtons(row)}</div>
                    </li>
                  )
                }
                return (
                  <li
                    key={row.key}
                    className="flex items-start justify-between gap-3 px-4 py-3"
                    data-testid="due-row"
                    data-kind="recurring"
                    data-view={row.view ?? 'full'}
                    data-source={`budget_entry:${row.entryId}`}
                  >
                    <div>
                      <p className="text-sm font-medium text-ink">{row.name}</p>
                      <p className="text-xs text-muted">
                        {formatEntryDate(row.occurrenceDate)}
                        {row.accountName && ` · ${row.accountName}`}
                        {row.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
                      </p>
                    </div>
                    <div className="flex-shrink-0 space-y-1 text-right">
                      {row.amount !== null && row.currency !== null && (
                        <p className="text-sm font-semibold text-ink">{formatCurrency(row.amount, row.currency)}</p>
                      )}
                      <div className="flex flex-wrap justify-end gap-2">{actionButtons(row)}</div>
                    </div>
                  </li>
                )
              })}
              {pending.map(pendingRow)}
            </ul>
          )}
          {hasMore && (
            <div className="px-4 py-3">
              <button type="button" onClick={loadMore} className={buttonClass} data-testid="due-load-more">
                Load more
              </button>
            </div>
          )}
        </div>
      )}
      {target && (
        <MarkPaidDialog
          entryId={target.entryId}
          name={target.name}
          occurrenceDate={target.occurrenceDate}
          {...(target.action ? { action: target.action } : {})}
          onClose={() => setTarget(null)}
          onPaid={onChanged}
        />
      )}
    </section>
  )
}
