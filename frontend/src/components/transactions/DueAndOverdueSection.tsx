import { useEffect, useId, useMemo, useState } from 'react'
import { shallowEqual, useDispatch, useSelector } from 'react-redux'
import {
  DUE_PAGE_SIZE,
  effectiveDuePage,
  LIMITED_ROWS,
  RECURRING_ACTION_LABELS,
  PENDING_POST_LABELS,
  dueRecurringRows,
  duePendingRows,
  dueStatementRows,
  formatEntryDate,
  orderDueRows,
  pageWindow,
  pendingLinkIds,
  transactionDescription,
} from '@tally-trace/shared'
import type {
  DuePageState,
  DueEntryRow,
  DueLimitedRow,
  DueMissedRow,
  DuePendingRow,
  DueRecurringRow,
  DueStatementRow,
  RecurringAction,
  Transaction,
} from '@tally-trace/shared'
import { useManilaDay } from '../../hooks/useManilaDay'
import { accountingApi, useGetDashboardSnapshotQuery, useGetTransactionsQuery } from '../../store/api'
import type { AppDispatch, RootState } from '../../store'
import { formatCurrency } from '../../utils/currency'
import { estimateText, estimateTitle } from '../../utils/fx'
import { CardPayDialog } from '../CardPayDialog'
import { MarkPaidDialog } from '../MarkPaidDialog'
import { Pager } from '../Pager'

/**
 * "Due and overdue": every recurring occurrence the caller can record and every pending
 * transaction that is overdue or tied to the schedule, in one place. Recurring rows come
 * from the dashboard snapshot (the same cache the dashboard fills; no new endpoint);
 * pending rows from transaction queries (the next 30 days, and the rows missed
 * occurrences link, whatever their date, in batches of 500). An owner or admin also gets one
 * row per card with an owed closed statement (`card_statements_due`), with Pay; the server
 * decides closed and overdue on the Manila day, so the snapshot is refetched when that day
 * changes. The merge, the dedup and the labels live in `@tally-trace/shared` (`dueSection.ts`).
 */

const WINDOW_DAYS = 30
const PAGE = 1000
/** The most ids one transactions request may name (the API's `ids` limit). */
const IDS_PER_REQUEST = 500

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

/**
 * The pending transactions with these ids: one cached query per batch of at most
 * `IDS_PER_REQUEST`, merged. Each batch stays subscribed, so it refetches when
 * transactions change, as a query hook would.
 */
function usePendingTransactionsByIds(ids: readonly number[]): { items: Transaction[]; failed: boolean; loading: boolean } {
  const dispatch = useDispatch<AppDispatch>()
  const batches = useMemo(() => {
    const out: { ids: number[]; is_posted: false; limit: number }[] = []
    for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) {
      const batch = ids.slice(start, start + IDS_PER_REQUEST)
      out.push({ ids: batch, is_posted: false, limit: batch.length })
    }
    return out
  }, [ids])
  useEffect(() => {
    const subscriptions = batches.map((args) => dispatch(accountingApi.endpoints.getTransactions.initiate(args)))
    return () => subscriptions.forEach((subscription) => subscription.unsubscribe())
  }, [dispatch, batches])
  const selectors = useMemo(() => batches.map((args) => accountingApi.endpoints.getTransactions.select(args)), [batches])
  const results = useSelector((state: RootState) => selectors.map((select) => select(state)), shallowEqual)
  const items = useMemo(() => results.flatMap((result) => result.data?.items ?? []), [results])
  return {
    items,
    failed: results.some((result) => result.error !== undefined),
    // A batch with nothing yet (first load, or new ids): its rows are missing, not gone.
    loading: results.some((result) => result.data === undefined && result.error === undefined),
  }
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
  // The card whose statement is being paid.
  const [payCardId, setPayCardId] = useState<number | null>(null)
  // Pages of the window query before the one on screen ("Load more").
  const [earlier, setEarlier] = useState<Transaction[]>([])
  const [offset, setOffset] = useState(0)
  // The page the reader chose and the day they chose it on: a new day is page 1, whatever else is loading.
  const [pageState, setPageState] = useState<DuePageState>({ page: 1, day: today })
  const page = effectiveDuePage(pageState, today)

  const { data: snapshot, isLoading: snapshotLoading, error: snapshotError, refetch: refetchSnapshot } = useGetDashboardSnapshotQuery({}, { refetchOnMountOrArgChange: true })
  // A new Manila day can close a statement or make one overdue.
  useManilaDay(() => void refetchSnapshot())
  const windowQuery = useGetTransactionsQuery({
    is_posted: false,
    end_date: `${addDays(today, WINDOW_DAYS)}T23:59:59`,
    limit: PAGE,
    offset,
  })
  const linkIds = useMemo(() => (snapshot ? pendingLinkIds(snapshot) : []), [snapshot])
  const { items: linkedTxns, failed: linkedFailed, loading: linkedLoading } = usePendingTransactionsByIds(linkIds)

  const windowItems = windowQuery.currentData?.items
  const windowTxns = useMemo(() => [...earlier, ...(windowItems ?? [])], [earlier, windowItems])
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
  const statements = useMemo(() => (snapshot ? dueStatementRows(snapshot) : []), [snapshot])
  // Overdue rows first, across every kind, so page 1 is where they are.
  const rows = useMemo(() => orderDueRows(recurring, pending, statements), [recurring, pending, statements])
  const count = rows.length
  const loading = snapshotLoading || windowQuery.isLoading
  const view = pageWindow(count, page, DUE_PAGE_SIZE)
  const visible = count > 0 ? rows.slice(view.from - 1, view.to) : []
  // A list that shrank leaves the reader on the last page that exists, and stays there if it grows again.
  useEffect(() => {
    if (!loading && !linkedLoading && view.page !== page) setPageState({ page: view.page, day: today })
  }, [loading, linkedLoading, view.page, page, today])

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

  const limitedRow = (row: DueLimitedRow) => (
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

  const missedRow = (row: DueMissedRow) => (
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

  const entryRow = (row: DueEntryRow) => (
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
        {row.currency !== null && (row.amount !== null || row.estimate.unconverted) && (
          <p className="text-sm font-semibold text-ink" data-testid="due-amount" title={estimateTitle(row.estimate)}>
            {estimateText(row.amount, row.currency, row.estimate)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">{actionButtons(row)}</div>
      </div>
    </li>
  )

  const statementRow = (row: DueStatementRow) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="statement"
      data-view="full"
      data-source={`statement:${row.cardId}`}
    >
      <div>
        <p className="text-sm font-medium text-ink">{row.name} statement</p>
        <p className="text-xs text-muted">
          Closed {formatEntryDate(row.closeDate)} · due {formatEntryDate(row.dueDate)}
          {row.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
          {row.statements > 1 && (
            <span data-testid="due-earlier-statements">
              {` · includes ${row.statements - 1} earlier ${row.statements - 1 === 1 ? 'statement' : 'statements'}`}
            </span>
          )}
        </p>
      </div>
      <div className="flex-shrink-0 space-y-1 text-right">
        <p
          className="text-sm font-semibold text-ink"
          data-testid="due-amount"
          {...(row.incomplete ? { title: 'may be low: some foreign charges have no exchange rate' } : {})}
        >
          {formatCurrency(row.amount, row.currency)}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setPayCardId(row.cardId)} className={primaryButtonClass} data-testid="due-pay">
            Pay
          </button>
        </div>
      </div>
    </li>
  )

  const recurringRow = (row: DueRecurringRow) => {
    if (row.view === 'limited') return limitedRow(row)
    if (row.kind === 'missed') return missedRow(row)
    return entryRow(row)
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
          {!snapshotError && (windowQuery.error !== undefined || linkedFailed) && (
            <p className="px-4 py-3 text-sm text-danger" role="alert" data-testid="due-pending-error">
              Could not load some pending transactions.
            </p>
          )}
          {!loading && !snapshotError && count === 0 && (
            <p className="px-4 py-3 text-sm text-muted" data-testid="due-empty">Nothing due or overdue in the next 30 days.</p>
          )}
          {count > 0 && (
            <ul className="divide-y divide-line" data-testid="due-list">
              {visible.map((row) =>
                row.kind === 'pending' ? pendingRow(row) : row.kind === 'statement' ? statementRow(row) : recurringRow(row),
              )}
            </ul>
          )}
          {count > DUE_PAGE_SIZE && (
            <div className="px-4 py-3">
              <Pager
                total={count}
                page={view.page}
                pageSize={DUE_PAGE_SIZE}
                onPage={(next) => setPageState({ page: next, day: today })}
                label="Due and overdue pages"
                testId="due-pager"
                disabled={loading}
              />
            </div>
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
      {payCardId !== null && <CardPayDialog cardId={payCardId} onClose={() => setPayCardId(null)} onPaid={onChanged} />}
    </section>
  )
}
