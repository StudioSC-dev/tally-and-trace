import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { shallowEqual, useDispatch, useSelector } from 'react-redux'
import {
  DUE_PAGE_SIZE,
  effectiveDuePage,
  LIMITED_ROWS,
  RECURRING_ACTION_LABELS,
  PENDING_POST_LABELS,
  dueRecurringRows,
  dueReviewNotice,
  duePendingRows,
  dueStatementRows,
  dueTodayLines,
  formatEntryDate,
  orderDueRows,
  pageWindow,
  pendingLinkIds,
  postedOnOpenText,
  postedResultText,
  postNowCount,
  postNowText,
  rowAmount,
  shouldPostOnOpen,
  statementRowText,
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
import {
  accountingApi,
  useGetDashboardSnapshotQuery,
  usePostDueInstallmentsMutation,
  usePostDueInstallmentsOnOpenMutation,
} from '../../store/api'
import type { AppDispatch, RootState } from '../../store'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'
import { apiErrorMessage } from '../../utils/apiError'
import { estimateText, estimateTitle } from '../../utils/fx'
import { CardPayDialog } from '../CardPayDialog'
import { InstallmentReviewDialog } from '../InstallmentReviewDialog'
import { MarkPaidDialog } from '../MarkPaidDialog'
import { Pager } from '../Pager'

/**
 * "Due and overdue": every recurring occurrence the caller can record and every pending
 * transaction that is overdue or tied to the schedule, in one place. Recurring rows come
 * from the dashboard snapshot (the same cache the dashboard fills; no new endpoint);
 * pending rows from transaction queries (the next 30 days, in batches of 1000 that "Load more"
 * adds to, every loaded batch staying subscribed; and the rows missed occurrences link,
 * whatever their date, in batches of 500). An owner or admin also gets one
 * row per card with an owed closed statement (`card_statements_due`), with Pay; the server
 * decides closed and overdue on the Manila day, so the snapshot is refetched when that day
 * changes. The merge, the dedup and the labels live in `@tally-trace/shared` (`dueSection.ts`).
 *
 * Card installments (STU-343 Plan B): each missed installment row says whether it
 * auto-posts, with Review where the caller can review it; a reviewed installment whose
 * only due month is today gets a compact line; installments that are not reviewed yet are
 * listed in a notice, each with Review; "Post N due installment months now" posts every
 * month the snapshot counts as postable (`postNowCount`); and a card's statement row
 * counts its installment months not posted yet, listing a card for those alone.
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

type TransactionsArgs = typeof accountingApi.endpoints.getTransactions.Types.QueryArg
type TransactionsResult = ReturnType<ReturnType<typeof accountingApi.endpoints.getTransactions.select>>

interface TransactionQueries {
  items: Transaction[]
  failed: boolean
  loading: boolean
  /** Some batch is loading or refetching, so the merged rows may be mid-change. */
  fetching: boolean
  /** The last batch's result. */
  last: TransactionsResult | undefined
}

/**
 * One cached transactions query per entry of `batches` (memoise the array), merged in order.
 * Each batch stays subscribed, so it refetches when transactions change, as a query hook would.
 */
function useTransactionQueries(batches: readonly TransactionsArgs[]): TransactionQueries {
  const dispatch = useDispatch<AppDispatch>()
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
    // A batch with nothing yet (first load, or new args): its rows are missing, not gone.
    loading: results.some((result) => result.data === undefined && result.error === undefined),
    fetching: results.some((result) => result.status === 'pending'),
    last: results[results.length - 1],
  }
}

/**
 * The pending transactions with these ids: one cached query per batch of at most
 * `IDS_PER_REQUEST`, merged. Each batch stays subscribed, so it refetches when
 * transactions change, as a query hook would.
 */
function usePendingTransactionsByIds(ids: readonly number[]): { items: Transaction[]; failed: boolean; loading: boolean } {
  const batches = useMemo(() => {
    const out: { ids: number[]; is_posted: false; limit: number }[] = []
    for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) {
      const batch = ids.slice(start, start + IDS_PER_REQUEST)
      out.push({ ids: batch, is_posted: false, limit: batch.length })
    }
    return out
  }, [ids])
  return useTransactionQueries(batches)
}

interface Props {
  /** The viewer's calendar day (`YYYY-MM-DD`). */
  today: string
  /** Post a pending transaction: the page's own posting flow. */
  onPost: (transaction: Transaction) => void
  /** After a recurring occurrence is recorded: refresh the page's lists. */
  onChanged: () => void
  /** Each account's currency by id, so a pending foreign row shows its face in its own currency; a row whose account is missing keeps its stored figure. */
  accountCurrencies?: ReadonlyMap<number, CurrencyCode>
}

interface ReviewTarget {
  entryId: number
  name: string
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

export function DueAndOverdueSection({ today, onPost, onChanged, accountCurrencies }: Props) {
  const panelId = useId()
  const [open, setOpen] = useState(true)
  const [target, setTarget] = useState<RecordTarget | null>(null)
  // The card whose statement is being paid.
  const [payCardId, setPayCardId] = useState<number | null>(null)
  // The installment being reviewed, and whether the review notice is expanded.
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null)
  const [noticeOpen, setNoticeOpen] = useState(false)
  // Post now: its last run's count and error, kept until the next run.
  const [postDue, { isLoading: posting }] = usePostDueInstallmentsMutation()
  const [posted, setPosted] = useState<number | null>(null)
  const [postError, setPostError] = useState<string | null>(null)
  // The page-open run (quiet: no loader, no toast): the months it posted, for a status line.
  const [postOnOpen] = usePostDueInstallmentsOnOpenMutation()
  const [openPosted, setOpenPosted] = useState<number | null>(null)
  // How many batches of the window query are loaded ("Load more") and the day they were: a new day is one batch.
  const [loaded, setLoaded] = useState({ count: 1, day: today })
  const batchCount = loaded.day === today ? loaded.count : 1
  // The page the reader chose and the day they chose it on: a new day is page 1, whatever else is loading.
  const [pageState, setPageState] = useState<DuePageState>({ page: 1, day: today })
  const page = effectiveDuePage(pageState, today)

  const {
    data: snapshot,
    requestId: snapshotRequestId,
    isSuccess: snapshotSuccess,
    isFetching: snapshotFetching,
    isError: snapshotIsError,
    isLoading: snapshotLoading,
    error: snapshotError,
    refetch: refetchSnapshot,
  } = useGetDashboardSnapshotQuery({}, { refetchOnMountOrArgChange: true })
  // The id of the request whose data was already settled when this mounted (a cache entry the dashboard filled);
  // undefined for a hard load or a request in flight. A ref keeps its first value, so that snapshot is never fresh.
  const mountRequestId = useRef<string | undefined>(snapshotFetching ? undefined : snapshotRequestId)
  // Consumed when this mount's first fresh snapshot is evaluated, whether or not a POST is sent.
  const pageOpenDone = useRef(false)
  // Page-open auto-post (Q1): once per mount, decided by a fresh snapshot, never a cached one. The effect lists
  // every value the gate reads: structural sharing keeps `snapshot`'s identity when a refetch returns the same
  // JSON, so only the request id says the response is new. A failed refetch is not fresh and consumes nothing.
  useEffect(() => {
    if (pageOpenDone.current) return
    if (snapshot === undefined || !snapshotSuccess || snapshotFetching || snapshotIsError) return
    if (snapshotRequestId === mountRequestId.current) return
    pageOpenDone.current = true
    if (!shouldPostOnOpen(snapshot)) return
    // Fired and forgotten: an error is swallowed (Post now stays available) and nothing awaits it in a render path.
    postOnOpen()
      .unwrap()
      .then((result) => setOpenPosted(result.posted))
      .catch(() => undefined)
  }, [snapshot, snapshotRequestId, snapshotSuccess, snapshotFetching, snapshotIsError, postOnOpen])
  // A new Manila day can close a statement or make one overdue.
  useManilaDay(() => void refetchSnapshot())
  const endDate = `${addDays(today, WINDOW_DAYS)}T23:59:59`
  // Every loaded batch stays subscribed, so all of them refetch together when transactions change.
  const windowBatches = useMemo(
    () => Array.from({ length: batchCount }, (_, i) => ({ is_posted: false, end_date: endDate, limit: PAGE, offset: i * PAGE })),
    [endDate, batchCount],
  )
  const windowResult = useTransactionQueries(windowBatches)
  const linkIds = useMemo(() => (snapshot ? pendingLinkIds(snapshot) : []), [snapshot])
  const { items: linkedTxns, failed: linkedFailed, loading: linkedLoading } = usePendingTransactionsByIds(linkIds)

  const windowTxns = windowResult.items
  const hasMore = windowResult.last?.data?.has_more === true

  const recurring = useMemo(() => (snapshot ? dueRecurringRows(snapshot, today) : []), [snapshot, today])
  const pending = useMemo(
    () => (snapshot ? duePendingRows(windowTxns, linkedTxns, snapshot, today) : []),
    [snapshot, windowTxns, linkedTxns, today],
  )
  const statements = useMemo(() => (snapshot ? dueStatementRows(snapshot) : []), [snapshot])
  const reviewNotice = useMemo(() => (snapshot ? dueReviewNotice(snapshot) : null), [snapshot])
  const todayLines = useMemo(() => (snapshot ? dueTodayLines(snapshot) : []), [snapshot])
  const postNow = snapshot ? postNowText(postNowCount(snapshot)) : null
  const openPostedText = openPosted === null ? null : postedOnOpenText(openPosted)
  // Overdue rows first, across every kind, so page 1 is where they are.
  const rows = useMemo(() => orderDueRows(recurring, pending, statements), [recurring, pending, statements])
  const count = rows.length
  const loading = snapshotLoading || windowResult.loading
  // First-load flags only: a refetch is not gated, it runs under the screen loader. A linked batch that lands adds rows, so the count waits for it.
  const countPending = loading || linkedLoading
  const view = pageWindow(count, page, DUE_PAGE_SIZE)
  const visible = count > 0 ? rows.slice(view.from - 1, view.to) : []
  // A list that shrank leaves the reader on the last page that exists, and stays there if it grows again.
  // Not while a window batch refetches: the batches land in any order, so a row can be briefly missing.
  useEffect(() => {
    if (!loading && !linkedLoading && !windowResult.fetching && view.page !== page) setPageState({ page: view.page, day: today })
  }, [loading, linkedLoading, windowResult.fetching, view.page, page, today])

  const loadMore = () => setLoaded({ count: batchCount + 1, day: today })

  const postDueNow = async () => {
    setPosted(null)
    setPostError(null)
    try {
      const result = await postDue().unwrap()
      setPosted(result.posted)
      onChanged()
    } catch (caught) {
      setPostError(apiErrorMessage(caught) || 'Could not post the due installment months. Please try again.')
    }
  }

  const review = (entryId: number, name: string) => setReviewTarget({ entryId, name })

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
    const accountCurrency = accountCurrencies?.get(txn.account_id)
    const shown = accountCurrency ? rowAmount(txn, accountCurrency) : { amount: txn.amount, currency: txn.currency }
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
          <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
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
        {row.autoPostLabel && (
          <p className="text-xs text-muted" data-testid="due-auto-post" data-state={row.autoPost ?? undefined}>
            {row.autoPostLabel}
          </p>
        )}
      </div>
      <div className="flex flex-shrink-0 flex-wrap justify-end gap-2">
        {row.review && (
          <button type="button" onClick={() => review(row.entryId, row.name)} className={buttonClass} data-testid="due-review">
            Review
          </button>
        )}
        {actionButtons(row)}
      </div>
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

  const statementRow = (row: DueStatementRow) => {
    const shown = statementRowText(row)
    const postButton = shown.post && (
      <button type="button" onClick={() => void postDueNow()} disabled={posting} className={buttonClass} data-testid="due-unposted-post">
        {posting ? 'Posting…' : 'Post due installments now'}
      </button>
    )
    return (
      <li
        key={row.key}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="statement"
        data-view="full"
        data-source={`statement:${row.cardId}`}
      >
        <div>
          {shown.unpostedOnly ? (
            <p className="text-sm font-medium text-ink" data-testid="due-unposted-text">{`${row.name} · ${shown.text ?? ''}`}</p>
          ) : (
            <p className="text-sm font-medium text-ink">{row.name} statement</p>
          )}
          <p className="text-xs text-muted">
            Closed {formatEntryDate(row.closeDate)} · due {formatEntryDate(row.dueDate)}
            {row.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
            {row.statements > 1 && (
              <span data-testid="due-earlier-statements">
                {` · includes ${row.statements - 1} earlier ${row.statements - 1 === 1 ? 'statement' : 'statements'}`}
              </span>
            )}
          </p>
          {shown.note && <p className="text-xs text-warn" data-testid="due-unposted-note">{shown.note}</p>}
          {shown.guidance && <p className="text-xs text-warn" data-testid="due-unposted-guidance">{shown.guidance}</p>}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          {!shown.unpostedOnly && (
            <p
              className="text-sm font-semibold text-ink"
              data-testid="due-amount"
              {...(row.incomplete ? { title: 'may be low: some foreign charges have no exchange rate' } : {})}
            >
              {formatCurrency(row.amount, row.currency)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {postButton}
            {shown.pay && (
              <button type="button" onClick={() => setPayCardId(row.cardId)} className={primaryButtonClass} data-testid="due-pay">
                Pay
              </button>
            )}
          </div>
        </div>
      </li>
    )
  }

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
          <span className="badge" data-testid="due-count">{countPending ? '…' : count}</span>
        </button>
      </h2>
      {open && (
        <div id={panelId} className="border-t border-line">
          {snapshotError && (
            <p className="px-4 py-3 text-sm text-danger" role="alert">Could not load what is due.</p>
          )}
          {!snapshotError && (windowResult.failed || linkedFailed) && (
            <p className="px-4 py-3 text-sm text-danger" role="alert" data-testid="due-pending-error">
              Could not load some pending transactions.
            </p>
          )}
          {reviewNotice && (
            <div className="border-b border-line px-4 py-3 space-y-2" data-testid="due-review-notice">
              <button
                type="button"
                onClick={() => setNoticeOpen((prev) => !prev)}
                aria-expanded={noticeOpen}
                className="text-sm font-medium text-warn underline underline-offset-2 focus-ring"
                data-testid="due-review-notice-toggle"
              >
                {reviewNotice.text}
              </button>
              {noticeOpen && (
                <ul className="space-y-2" data-testid="due-review-notice-list">
                  {reviewNotice.entries.map((entry) => (
                    <li
                      key={entry.entryId}
                      className="flex items-center justify-between gap-3"
                      data-testid="due-review-notice-entry"
                      data-source={`budget_entry:${entry.entryId}`}
                    >
                      <span className="text-sm text-ink">
                        {entry.name}
                        <span className="text-xs text-muted">
                          {` · ${entry.accountName}`}
                          {entry.missedCount > 0 && ` · ${entry.missedCount} missed`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => review(entry.entryId, entry.name)}
                        className={buttonClass}
                        data-testid="due-review-notice-review"
                      >
                        Review
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {todayLines.length > 0 && (
            <ul className="divide-y divide-line border-b border-line" data-testid="due-today-lines">
              {todayLines.map((line) => (
                <li
                  key={line.key}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                  data-testid="due-today-line"
                  data-source={`budget_entry:${line.entryId}`}
                  data-state={line.state}
                >
                  <span className="text-sm text-ink" data-testid="due-today-text">{line.text}</span>
                  {line.canReview && (
                    <button
                      type="button"
                      onClick={() => review(line.entryId, line.name)}
                      className={buttonClass}
                      data-testid="due-today-review"
                    >
                      Review
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {openPostedText !== null && (
            <p className="px-4 pt-3 text-sm text-ok" role="status" data-testid="due-page-open-result">{openPostedText}</p>
          )}
          {(postNow !== null || posted !== null || postError !== null) && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              {postNow !== null && (
                <button
                  type="button"
                  onClick={() => void postDueNow()}
                  disabled={posting}
                  className={primaryButtonClass}
                  data-testid="due-post-now"
                >
                  {posting ? 'Posting…' : postNow}
                </button>
              )}
              {posted !== null && (
                <p className="text-sm text-ok" role="status" data-testid="due-post-now-result">{postedResultText(posted)}</p>
              )}
              {postError !== null && (
                <p className="text-sm text-danger" role="alert" data-testid="due-post-now-error">{postError}</p>
              )}
            </div>
          )}
          {!countPending && !snapshotError && count === 0 && (
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
      {reviewTarget && (
        <InstallmentReviewDialog
          key={reviewTarget.entryId}
          entryId={reviewTarget.entryId}
          name={reviewTarget.name}
          onClose={() => setReviewTarget(null)}
          onReviewed={onChanged}
        />
      )}
    </section>
  )
}
