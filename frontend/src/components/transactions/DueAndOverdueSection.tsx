import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { shallowEqual, useDispatch, useSelector } from 'react-redux'
import {
  CAP_REASON,
  DUE_PAGE_SIZE,
  atCap,
  batchConfirmMessage,
  batchSummary,
  cleanIds,
  effectiveDuePage,
  effectiveSelection,
  LIMITED_ROWS,
  RECURRING_ACTION_LABELS,
  PENDING_POST_LABELS,
  dayEndWire,
  dueRecurringRows,
  dueReviewNotice,
  duePendingRows,
  dueStatementRows,
  dueTodayLines,
  formatEntryDate,
  dueTabBadge,
  freshFor,
  installmentPlanView,
  mergeUpcoming,
  occurrenceCreditCheck,
  orderSubscriptionRows,
  subscriptionPastRows,
  notPostedRows,
  orderDueRows,
  pageWindow,
  pendingLinkIds,
  postedOnOpenText,
  postedResultText,
  postNowCount,
  postNowText,
  reviewBatchItems,
  reviewSelectedText,
  rowAmount,
  selectAll,
  selectAllState,
  shouldPostOnOpen,
  statementRowText,
  tabKeyTarget,
  toggleSelection,
  transactionDescription,
  transactionStatus,
  UPCOMING_LIMIT,
  upcomingShownText,
  upcomingWindow,
  wallDay,
  transactionDate,
} from '@tally-trace/shared'
import type {
  BatchFailure,
  DueBadge,
  DuePageState,
  DueEntryRow,
  DueLimitedRow,
  DueMissedRow,
  DuePendingRow,
  DueRecurringRow,
  DueStatementRow,
  NotPostedRow,
  RecurringAction,
  Transaction,
  CreditCheck,
  InstallmentPlan,
  SubscriptionRow,
  TransactionStatus,
  UpcomingOccurrence,
  UpcomingRow,
} from '@tally-trace/shared'
import { useConfirm } from '../../hooks/useConfirm'
import { useManilaDay } from '../../hooks/useManilaDay'
import { useToday } from '../../hooks/useToday'
import {
  accountingApi,
  useGetDashboardSnapshotQuery,
  useGetInstallmentPlansQuery,
  useGetTransactionsQuery,
  useGetUpcomingOccurrencesQuery,
  usePostDueInstallmentsMutation,
  usePostDueInstallmentsOnOpenMutation,
  useReviewInstallmentsMutation,
} from '../../store/api'
import type { AppDispatch, RootState } from '../../store'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'
import { apiErrorMessage } from '../../utils/apiError'
import { estimateText, estimateTitle } from '../../utils/fx'
import { CardPayDialog } from '../CardPayDialog'
import { CreditCheckBadge } from '../CreditSummary'
import { InstallmentReviewDialog } from '../InstallmentReviewDialog'
import { MarkPaidDialog } from '../MarkPaidDialog'
import { Pager } from '../Pager'
import { UpcomingOccurrenceRow } from './UpcomingOccurrenceRow'

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
 *
 * ARIA tabs share the card, built from `TABS` (STU-485, STU-511): "Due and overdue" (the
 * default) holds what is owed, with the review notice, today lines, the page-open status and
 * Post now; "Not posted yet" holds the one-off pending rows (no recurring link) dated today or
 * earlier, each with "logged N days ago" on the Manila day; "Upcoming" holds the fixed window
 * from the Manila day (T+1 to T+30, whatever the page's month and filters): transactions in
 * every state, soonest first, and the occurrences of entries no other tab lists (`plan=none`),
 * as compact rows; "Subscriptions" holds the open-ended subscriptions (`plan_kind`
 * `subscription`): missed, today's and overdue rows from the snapshot and the same window's
 * occurrences, card rows with the owner's credit check; "Installments" holds one row per
 * active installment plan with its next charge and "N of M left". A transaction row opens the
 * page's action modal; every recurring action opens this card's dialogs. Each windowed tab
 * reads `currentData` for arguments built from `today`, and the snapshot and the plans must be
 * for that day (`freshFor`), so a new Manila day reads "…" until its data lands. Every panel shell stays mounted; only the selected panel of an
 * open card has content. The tab and each tab's page are component state only.
 */

const WINDOW_DAYS = 30
const PAGE = 1000
/** The most ids one transactions request may name (the API's `ids` limit). */
const IDS_PER_REQUEST = 500
/** The most occurrences one window request lists (the API's `limit` maximum); its `total` stays exact. */
const OCCURRENCE_LIMIT = 500

const ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'due-mark-paid',
  mark_received: 'due-mark-received',
  charged: 'due-charged',
  posted: 'due-posted',
}

type DueTab = 'due' | 'not_posted' | 'upcoming' | 'subscriptions' | 'installments'
/** The tabs whose badge `dueTabBadge` decides from their sources. */
type WindowBadgeTab = 'upcoming' | 'subscriptions' | 'installments'

/** One tab of the card: its label, its test-id slug, its badge's test id, and whether it lists the window batches (so "Load more" applies). */
interface TabSpec {
  id: DueTab
  label: string
  slug: string
  badgeTestId: string
  usesWindow: boolean
}

const TABS: readonly TabSpec[] = [
  { id: 'due', label: 'Due and overdue', slug: 'due', badgeTestId: 'due-count', usesWindow: true },
  { id: 'not_posted', label: 'Not posted yet', slug: 'not-posted', badgeTestId: 'due-not-posted-count', usesWindow: true },
  { id: 'upcoming', label: 'Upcoming', slug: 'upcoming', badgeTestId: 'due-upcoming-count', usesWindow: false },
  { id: 'subscriptions', label: 'Subscriptions', slug: 'subscriptions', badgeTestId: 'due-subscriptions-count', usesWindow: false },
  { id: 'installments', label: 'Installments', slug: 'installments', badgeTestId: 'due-installments-count', usesWindow: false },
]

const STATUS_LABELS: Record<TransactionStatus, string> = { planned: 'Planned', pending: 'Pending', posted: 'Posted' }

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

/**
 * One tab's pager window: the reader's page for today, and a list that shrank leaves the reader
 * on the last page that exists (staying there if it grows again). Only once `settled`: the window
 * batches land out of order, so a row can be briefly missing.
 */
function useClampedPage(
  count: number,
  tab: DueTab,
  state: DuePageState,
  setState: (tab: DueTab, state: DuePageState) => void,
  today: string,
  settled: boolean,
): ReturnType<typeof pageWindow> {
  const page = effectiveDuePage(state, today)
  const view = pageWindow(count, page, DUE_PAGE_SIZE)
  useEffect(() => {
    if (settled && view.page !== page) setState(tab, { page: view.page, day: today })
  }, [settled, view.page, page, today, tab, setState])
  return view
}

interface Props {
  /** The viewer's calendar day (`YYYY-MM-DD`). */
  today: string
  /** Post a pending transaction: the page's own posting flow. */
  onPost: (transaction: Transaction) => void
  /** After a recurring occurrence is recorded: refresh the page's lists. */
  onChanged: () => void
  /** Open an Upcoming transaction in the page's action modal (Edit, Delete, Post). */
  onOpenTransaction: (transaction: Transaction) => void
  /** Each account's currency by id, so a pending foreign row shows its face in its own currency; a row whose account is missing keeps its stored figure. */
  accountCurrencies?: ReadonlyMap<number, CurrencyCode>
}

interface ReviewTarget {
  entryId: number
  name: string
}

/** The last batch review's outcome: its line and one failure per entry that was not reviewed, kept for its Manila day. */
interface BatchResultView {
  day: string
  text: string | null
  failures: BatchFailure[]
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

export function DueAndOverdueSection({ today, onPost, onChanged, onOpenTransaction, accountCurrencies }: Props) {
  const panelId = useId()
  const [open, setOpen] = useState(true)
  // The selected tab: Due and overdue on every mount, never stored.
  const [tab, setTab] = useState<DueTab>('due')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [target, setTarget] = useState<RecordTarget | null>(null)
  // The card whose statement is being paid.
  const [payCardId, setPayCardId] = useState<number | null>(null)
  // The installment being reviewed, and whether the review notice is expanded.
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null)
  const [noticeOpen, setNoticeOpen] = useState(false)
  // Batch review: the ticked ids, whether a batch runs, and the last run's result (kept until the next run or the next day).
  const askConfirm = useConfirm()
  const [reviewBatch] = useReviewInstallmentsMutation()
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [batching, setBatching] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchResultView | null>(null)
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
  // Each tab's page the reader chose and the day they chose it on: a new day is page 1, whatever else is loading.
  const [pageStates, setPageStates] = useState<Record<DueTab, DuePageState>>(() => ({
    due: { page: 1, day: today },
    not_posted: { page: 1, day: today },
    upcoming: { page: 1, day: today },
    subscriptions: { page: 1, day: today },
    installments: { page: 1, day: today },
  }))
  const setPageState = useCallback(
    (id: DueTab, state: DuePageState) => setPageStates((prev) => ({ ...prev, [id]: state })),
    [],
  )

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
  const endDate = dayEndWire(addDays(today, WINDOW_DAYS))
  // Every loaded batch stays subscribed, so all of them refetch together when transactions change.
  const windowBatches = useMemo(
    () => Array.from({ length: batchCount }, (_, i) => ({ is_posted: false, end_date: endDate, limit: PAGE, offset: i * PAGE })),
    [endDate, batchCount],
  )
  const windowResult = useTransactionQueries(windowBatches)
  const linkIds = useMemo(() => (snapshot ? pendingLinkIds(snapshot) : []), [snapshot])
  const { items: linkedTxns, failed: linkedFailed, loading: linkedLoading } = usePendingTransactionsByIds(linkIds)
  // Upcoming: the fixed window from the Manila day. Its arguments come from `today`, so a new
  // day is a new cache entry, and `currentData` reads it as not loaded until it lands.
  const upcomingRange = useMemo(() => upcomingWindow(today), [today])
  const upcomingTxnResult = useGetTransactionsQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, order: 'asc', limit: UPCOMING_LIMIT, offset: 0 },
    { refetchOnMountOrArgChange: true },
  )
  const upcomingOccResult = useGetUpcomingOccurrencesQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, plan: 'none', limit: OCCURRENCE_LIMIT },
    { refetchOnMountOrArgChange: true },
  )
  // Subscriptions: the same window's occurrences of `plan_kind` `subscription` entries.
  const subscriptionOccResult = useGetUpcomingOccurrencesQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, plan: 'subscription', limit: OCCURRENCE_LIMIT },
    { refetchOnMountOrArgChange: true },
  )
  // Installments: one row per active plan. `day` is only the cache key, so a new day is a new request.
  const plansResult = useGetInstallmentPlansQuery({ day: today }, { refetchOnMountOrArgChange: true })
  // The viewer's local day: an Upcoming transaction's Planned / Pending / Posted label only.
  const localDay = useToday()

  const windowTxns = windowResult.items
  const hasMore = windowResult.last?.data?.has_more === true

  const recurring = useMemo(() => (snapshot ? dueRecurringRows(snapshot, today) : []), [snapshot, today])
  const pending = useMemo(
    () => (snapshot ? duePendingRows(windowTxns, linkedTxns, snapshot, today) : []),
    [snapshot, windowTxns, linkedTxns, today],
  )
  const statements = useMemo(() => (snapshot ? dueStatementRows(snapshot) : []), [snapshot])
  const reviewNotice = useMemo(() => (snapshot ? dueReviewNotice(snapshot) : null), [snapshot])
  // Only ticked rows that are still clean in the current snapshot count, so a refetch drops a stale tick with no effect.
  const effective = useMemo(() => effectiveSelection(selected, reviewNotice), [selected, reviewNotice])
  const cleanCount = cleanIds(reviewNotice).length
  const allState = selectAllState(selected, reviewNotice)
  const capped = atCap(selected, reviewNotice)
  const limitId = `${panelId}-limit`
  const todayLines = useMemo(() => (snapshot ? dueTodayLines(snapshot) : []), [snapshot])
  const postNow = snapshot ? postNowText(postNowCount(snapshot)) : null
  const openPostedText = openPosted === null ? null : postedOnOpenText(openPosted)
  // Overdue rows first, across every kind, so page 1 is where they are.
  const rows = useMemo(() => orderDueRows(recurring, pending, statements), [recurring, pending, statements])
  const count = rows.length
  const loading = snapshotLoading || windowResult.loading
  // First-load flags only: a refetch is not gated, it runs under the screen loader. A linked batch that lands adds rows, so the count waits for it.
  const countPending = loading || linkedLoading
  const view = useClampedPage(count, 'due', pageStates.due, setPageState, today, !countPending && !windowResult.fetching)
  const visible = count > 0 ? rows.slice(view.from - 1, view.to) : []
  // Not posted yet: the window's one-off rows only, so its count never waits for the linked batches.
  const notPosted = useMemo(() => notPostedRows(windowTxns, today), [windowTxns, today])
  const notPostedCount = notPosted.length
  const notPostedView = useClampedPage(
    notPostedCount,
    'not_posted',
    pageStates.not_posted,
    setPageState,
    today,
    !loading && !windowResult.fetching,
  )
  const notPostedVisible = notPostedCount > 0 ? notPosted.slice(notPostedView.from - 1, notPostedView.to) : []
  // The Upcoming, Subscriptions and Installments badges are decided by `dueTabBadge` from each source's
  // state and the tab's last complete total for the Manila day, kept here when the rule marks a figure complete.
  const lastComplete = useRef<Partial<Record<WindowBadgeTab, { day: string; total: number }>>>({})
  const keptFor = (id: WindowBadgeTab) => {
    const kept = lastComplete.current[id]
    return kept !== undefined && kept.day === today ? kept.total : undefined
  }
  // Upcoming: both sources soonest first, merged and cut at UPCOMING_LIMIT; the badge is the exact total.
  const upcomingTxns = upcomingTxnResult.currentData
  const upcomingOccs = upcomingOccResult.currentData
  const upcomingFailed = upcomingTxnResult.isError || upcomingOccResult.isError
  const upcomingPending =
    (upcomingTxns === undefined && !upcomingTxnResult.isError) || (upcomingOccs === undefined && !upcomingOccResult.isError)
  const upcomingRows = useMemo(
    () => mergeUpcoming(upcomingTxns?.items ?? [], upcomingOccs?.items ?? [], UPCOMING_LIMIT),
    [upcomingTxns, upcomingOccs],
  )
  const upcomingBadge = dueTabBadge(
    [
      { hasData: upcomingTxns !== undefined, fresh: true, fetching: upcomingTxnResult.isFetching, failed: upcomingTxnResult.isError, count: upcomingTxns?.total ?? 0 },
      { hasData: upcomingOccs !== undefined, fresh: true, fetching: upcomingOccResult.isFetching, failed: upcomingOccResult.isError, count: upcomingOccs?.total ?? 0 },
    ],
    keptFor('upcoming'),
  )
  const upcomingShown = upcomingBadge.figure === 'pending' ? null : upcomingShownText(upcomingBadge.figure)
  const upcomingCount = upcomingRows.length
  const upcomingView = useClampedPage(
    upcomingCount,
    'upcoming',
    pageStates.upcoming,
    setPageState,
    today,
    !upcomingPending && !upcomingTxnResult.isFetching && !upcomingOccResult.isFetching,
  )
  const upcomingVisible = upcomingCount > 0 ? upcomingRows.slice(upcomingView.from - 1, upcomingView.to) : []
  const retryUpcoming = () => {
    void upcomingTxnResult.refetch()
    void upcomingOccResult.refetch()
  }
  // Subscriptions: the snapshot's rows dated today or earlier, only while the snapshot is for
  // today, and the window's occurrences. While either has failed the badge is the last complete total (D7).
  const snapshotFresh = snapshot !== undefined && freshFor(snapshot.today, today)
  const subscriptionPast = useMemo(
    () => (snapshot !== undefined && snapshotFresh ? subscriptionPastRows(snapshot, today) : []),
    [snapshot, snapshotFresh, today],
  )
  const subscriptionOccs = subscriptionOccResult.currentData
  const subscriptionFailed = subscriptionOccResult.isError
  const subscriptionPending =
    (!snapshotFresh && !snapshotIsError) || (subscriptionOccs === undefined && !subscriptionOccResult.isError)
  const subscriptionRows = useMemo(
    () => orderSubscriptionRows(subscriptionPast, subscriptionOccs?.items ?? []),
    [subscriptionPast, subscriptionOccs],
  )
  const subscriptionBadge = dueTabBadge(
    [
      { hasData: snapshot !== undefined, fresh: snapshotFresh, fetching: snapshotFetching, failed: snapshotIsError, count: subscriptionPast.length },
      { hasData: subscriptionOccs !== undefined, fresh: true, fetching: subscriptionOccResult.isFetching, failed: subscriptionOccResult.isError, count: subscriptionOccs?.total ?? 0 },
    ],
    keptFor('subscriptions'),
  )
  const subscriptionCount = subscriptionRows.length
  const subscriptionView = useClampedPage(
    subscriptionCount,
    'subscriptions',
    pageStates.subscriptions,
    setPageState,
    today,
    !subscriptionPending && !snapshotFetching && !subscriptionOccResult.isFetching,
  )
  const subscriptionVisible =
    subscriptionCount > 0 ? subscriptionRows.slice(subscriptionView.from - 1, subscriptionView.to) : []
  // The card credit check of an entry's occurrence on `day` (owner or admin only), from a snapshot for today.
  const creditFor = (entryId: number, day: string): CreditCheck | undefined =>
    snapshot !== undefined && snapshotFresh ? occurrenceCreditCheck(snapshot.card_charges, entryId, day) : undefined
  // Installments: the plans, only while they are for today; its badge follows the shared rule (D7).
  const plans = plansResult.currentData
  const plansFresh = plans !== undefined && freshFor(plans.today, today)
  const planItems = useMemo(() => (plans !== undefined && plansFresh ? plans.items : []), [plans, plansFresh])
  const plansFailed = plansResult.isError
  const plansPending = !plansFresh && !plansFailed
  const planCount = planItems.length
  const planBadge = dueTabBadge(
    [{ hasData: plans !== undefined, fresh: plansFresh, fetching: plansResult.isFetching, failed: plansFailed, count: planCount }],
    keptFor('installments'),
  )
  // Keep each window tab's total for the day when its rule marks it complete.
  useEffect(() => {
    const complete: [WindowBadgeTab, DueBadge][] = [['upcoming', upcomingBadge], ['subscriptions', subscriptionBadge], ['installments', planBadge]]
    for (const [id, badge] of complete) {
      if (badge.complete && typeof badge.figure === 'number') lastComplete.current[id] = { day: today, total: badge.figure }
    }
  })
  const planView = useClampedPage(
    planCount,
    'installments',
    pageStates.installments,
    setPageState,
    today,
    !plansPending && !plansResult.isFetching,
  )
  const planVisible = planCount > 0 ? planItems.slice(planView.from - 1, planView.to) : []
  // Each tab's badge: "…" while its count is not settled.
  const figure = (badge: DueBadge) => ({ pending: badge.figure === 'pending', count: badge.figure === 'pending' ? 0 : badge.figure })
  const badges: Record<DueTab, { pending: boolean; count: number }> = {
    due: { pending: countPending, count },
    not_posted: { pending: loading, count: notPostedCount },
    upcoming: figure(upcomingBadge),
    subscriptions: figure(subscriptionBadge),
    installments: figure(planBadge),
  }
  const selectedUsesWindow = TABS.find((spec) => spec.id === tab)?.usesWindow === true

  const titleId = `${panelId}-title`
  const tabId = (id: DueTab) => `${panelId}-tab-${id}`
  const tabPanelId = (id: DueTab) => `${panelId}-panel-${id}`
  // Selecting a tab, by click or key, also opens a collapsed card.
  const selectTab = (id: DueTab) => {
    setTab(id)
    setOpen(true)
  }
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabKeyTarget(event.key, index, TABS.length)
    const nextTab = next === null ? undefined : TABS[next]
    if (next === null || nextTab === undefined) return
    event.preventDefault()
    selectTab(nextTab.id)
    tabRefs.current[next]?.focus()
  }

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

  const batchBusy = snapshotFetching || batching

  const reviewSelected = () => {
    if (!snapshot || reviewNotice === null) return
    const items = reviewBatchItems(snapshot, effective)
    if (items.length === 0) return
    // Names are captured now, so a failure still names a row that has left the list.
    const names = new Map(reviewNotice.entries.map((e) => [e.entryId, e.name] as const))
    void askConfirm({
      title: 'Turn on auto-post',
      message: batchConfirmMessage(items.length),
      confirmLabel: 'Turn on auto-post',
      tone: 'default',
      action: async () => {
        setBatching(true)
        try {
          const result = await reviewBatch({ items }).unwrap()
          setBatchResult({ day: today, ...batchSummary(result, names) })
          setSelected(new Set())
          onChanged()
        } finally {
          setBatching(false)
        }
      },
    })
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

  // A one-off pending row in Not posted yet: never overdue, no edit link, "{date} · logged …".
  const notPostedRow = (row: NotPostedRow) => {
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
        data-logged-days={row.daysAgo ?? undefined}
      >
        <div>
          <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Pending transaction'}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(row.date)} · <span data-testid="due-logged">{row.logged}</span>
          </p>
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
          {row.action && (
            <button type="button" onClick={() => onPost(txn)} className={primaryButtonClass} data-testid="due-mark-posted">
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

  // `plan` marks a row of the Subscriptions tab (`data-plan`).
  const missedRow = (row: DueMissedRow, plan?: string) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="missed"
      data-view={row.view ?? 'full'}
      data-source={`budget_entry:${row.entryId}`}
      data-plan={plan}
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

  // `plan` marks a row of the Subscriptions tab (`data-plan`); `credit` is its card credit check.
  const entryRow = (row: DueEntryRow, plan?: string, credit?: CreditCheck) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="recurring"
      data-view={row.view ?? 'full'}
      data-source={`budget_entry:${row.entryId}`}
      data-plan={plan}
    >
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <p className="text-xs text-muted">
          {formatEntryDate(row.occurrenceDate)}
          {row.accountName && ` · ${row.accountName}`}
          {row.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
        </p>
        {credit && <CreditCheckBadge check={credit} />}
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

  // An Upcoming transaction: one button that opens it in the page's action modal.
  const upcomingTransactionRow = (txn: Transaction) => {
    // A Limited row has no account id, so it keeps its stored figure.
    const accountCurrency = txn.view === 'limited' ? undefined : accountCurrencies?.get(txn.account_id)
    const shown = accountCurrency ? rowAmount(txn, accountCurrency) : { amount: txn.amount, currency: txn.currency }
    const day = wallDay(transactionDate(txn))
    return (
      <li
        key={`txn:${txn.id}`}
        data-testid="due-row"
        data-kind="upcoming"
        data-view={txn.view}
        data-source={`transaction:${txn.id}`}
        data-day={day}
      >
        <button
          type="button"
          onClick={() => onOpenTransaction(txn)}
          className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-sunken transition-colors focus-ring"
          data-testid="upcoming-transaction"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Transaction'}</p>
            <p className="text-xs text-muted">
              {formatEntryDate(day)} · {STATUS_LABELS[transactionStatus(txn, localDay)]}
            </p>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
          </div>
        </button>
      </li>
    )
  }

  const upcomingRow = (row: UpcomingRow) =>
    row.kind === 'transaction'
      ? upcomingTransactionRow(row.transaction)
      : occurrenceRow(row.occurrence, row.key, upcomingOccs?.auto_post_scheduled ?? false)

  // A future occurrence as a compact row, in Upcoming or Subscriptions; its actions open this card's dialogs.
  const occurrenceRow = (occurrence: UpcomingOccurrence, key: string, scheduled: boolean, credit?: CreditCheck) => (
    <UpcomingOccurrenceRow
      key={key}
      occurrence={occurrence}
      scheduled={scheduled}
      credit={credit}
      onRecord={(action) =>
        setTarget({ entryId: occurrence.entry_id, name: occurrence.name, occurrenceDate: occurrence.occurrence_date, action })
      }
      onReview={() => review(occurrence.entry_id, occurrence.name)}
    />
  )

  const subscriptionRow = (row: SubscriptionRow) => {
    if (row.kind === 'occurrence') {
      const occ = row.occurrence
      return occurrenceRow(occ, row.key, subscriptionOccs?.auto_post_scheduled ?? false, creditFor(occ.entry_id, occ.occurrence_date))
    }
    if (row.kind === 'missed') return missedRow(row, 'subscription')
    return entryRow(row, 'subscription', creditFor(row.entryId, row.occurrenceDate))
  }

  // One installment plan: its next charge, "N of M left", and the actions on that charge.
  const planRow = (plan: InstallmentPlan) => {
    const shown = installmentPlanView(plan, today, plans?.auto_post_scheduled ?? false)
    const next = plan.next_charge
    return (
      <li
        key={plan.entry_id}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="installment"
        data-view={plan.view}
        data-source={`budget_entry:${plan.entry_id}`}
        data-day={next ?? undefined}
        data-plan="installment"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{plan.name}</p>
          <p className="text-sm font-semibold text-ink" data-testid="due-payments-left">{shown.leftText}</p>
          <p className="text-xs text-muted">
            {shown.nextText}
            {shown.overdue && <span className="text-danger" data-testid="due-overdue"> · Overdue</span>}
            {shown.missedText !== null && (
              <span className="text-warn" data-testid="due-installment-missed">{` · ${shown.missedText}`}</span>
            )}
            {plan.account_name && ` · ${plan.account_name}`}
          </p>
          {shown.autoPostLabel && (
            <p className="text-xs text-muted" data-testid="due-auto-post" data-state={plan.auto_post ?? undefined}>
              {shown.autoPostLabel}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink" data-testid="due-amount">
            {formatCurrency(plan.amount, plan.currency as CurrencyCode)}
          </p>
          {next !== null && (shown.review || shown.actions.length > 0) && (
            <div className="flex flex-wrap justify-end gap-2">
              {shown.review && (
                <button type="button" onClick={() => review(plan.entry_id, plan.name)} className={buttonClass} data-testid="due-review">
                  Review
                </button>
              )}
              {shown.actions.map((action, index) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => setTarget({ entryId: plan.entry_id, name: plan.name, occurrenceDate: next, action })}
                  className={index === 0 ? primaryButtonClass : buttonClass}
                  data-testid={ACTION_TEST_IDS[action]}
                >
                  {RECURRING_ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          )}
        </div>
      </li>
    )
  }

  // The window's through line, and its note when one tab's occurrences pass the request limit.
  const throughLine = (extra: ReactNode) => (
    <p className="px-4 pt-3 text-xs text-muted" data-testid="due-through">
      Through {formatEntryDate(upcomingRange.through)}
      {extra}
    </p>
  )
  const cappedNote = (result: { items: unknown[]; total: number } | undefined) =>
    result !== undefined && result.total > result.items.length ? (
      <p className="px-4 pt-2 text-xs text-warn" data-testid="due-occurrences-capped">
        {`Only the first ${result.items.length} of ${result.total} recurring charges in this window are listed.`}
      </p>
    ) : null
  const windowError = (retry: () => void) => (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="due-window-error">
      <p className="text-sm text-danger" role="alert">Could not load what is coming up.</p>
      <button type="button" onClick={retry} className={buttonClass} data-testid="due-window-retry">
        Retry
      </button>
    </div>
  )

  const recurringRow = (row: DueRecurringRow) => {
    if (row.view === 'limited') return limitedRow(row)
    if (row.kind === 'missed') return missedRow(row)
    return entryRow(row)
  }

  // Each tab's content, mounted only in its own panel while the card is open and the tab selected.
  const panels: Record<DueTab, () => ReactNode> = {
    due: () => (
      <>
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
              <>
                {cleanCount > 0 && (
                  <div className="flex flex-wrap items-center gap-3" data-testid="due-review-notice-header">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        ref={(el) => {
                          if (el) el.indeterminate = allState === 'some'
                        }}
                        checked={allState === 'all'}
                        disabled={batchBusy}
                        onChange={() => setSelected(allState === 'all' ? new Set() : selectAll(reviewNotice))}
                        className="border-line focus-ring"
                        data-testid="due-review-notice-select-all"
                      />
                      Select all
                    </label>
                    <button
                      type="button"
                      onClick={reviewSelected}
                      disabled={batchBusy || effective.size === 0}
                      className={primaryButtonClass}
                      data-testid="due-review-selected"
                    >
                      {reviewSelectedText(effective.size)}
                    </button>
                    {capped && (
                      <p id={limitId} className="text-xs text-muted" data-testid="due-review-notice-limit">{CAP_REASON}</p>
                    )}
                  </div>
                )}
                <ul className="space-y-2" data-testid="due-review-notice-list">
                  {reviewNotice.entries.map((entry) => {
                    const nameId = `${panelId}-name-${entry.entryId}`
                    const reasonId = `${panelId}-reason-${entry.entryId}`
                    const ticked = effective.has(entry.entryId)
                    const blockedByCap = entry.clean && capped && !ticked
                    const describedBy = !entry.clean ? reasonId : blockedByCap ? limitId : undefined
                    return (
                      <li
                        key={entry.entryId}
                        className="flex items-center justify-between gap-3"
                        data-testid="due-review-notice-entry"
                        data-source={`budget_entry:${entry.entryId}`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={ticked}
                            disabled={!entry.clean || batchBusy || blockedByCap}
                            onChange={() => setSelected((prev) => toggleSelection(prev, entry.entryId, reviewNotice))}
                            aria-labelledby={nameId}
                            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
                            className="border-line focus-ring"
                            data-testid="due-review-notice-select"
                          />
                          <span className="text-sm text-ink">
                            <span id={nameId}>{entry.name}</span>
                            <span className="text-xs text-muted">
                              {` · ${entry.accountName}`}
                              {entry.reason !== null && (
                                <>
                                  {' · '}
                                  <span id={reasonId} data-testid="due-review-notice-reason">{entry.reason}</span>
                                </>
                              )}
                            </span>
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
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}
        {batchResult !== null && batchResult.day === today && (batchResult.text !== null || batchResult.failures.length > 0) && (
          <div className="border-b border-line px-4 py-3 space-y-2" data-testid="due-review-batch">
            {batchResult.text !== null && (
              <p className="text-sm text-ok" role="status" data-testid="due-review-batch-result">{batchResult.text}</p>
            )}
            {batchResult.failures.length > 0 && (
              <ul className="space-y-1">
                {batchResult.failures.map((f) => (
                  <li
                    key={f.entryId}
                    className="text-sm text-danger"
                    role="alert"
                    data-testid="due-review-batch-failure"
                    data-source={`budget_entry:${f.entryId}`}
                  >
                    {f.text}
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
              onPage={(next) => setPageState('due', { page: next, day: today })}
              label="Due and overdue pages"
              testId="due-pager"
              disabled={loading}
            />
          </div>
        )}
      </>
    ),
    not_posted: () => (
      <>
        {!loading && !snapshotError && notPostedCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-not-posted-empty">Nothing waiting to post.</p>
        )}
        {notPostedCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {notPostedVisible.map((row) => notPostedRow(row))}
          </ul>
        )}
        {notPostedCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={notPostedCount}
              page={notPostedView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('not_posted', { page: next, day: today })}
              label="Not posted yet pages"
              testId="due-pager"
              disabled={loading}
            />
          </div>
        )}
      </>
    ),
    upcoming: () => (
      <>
        {throughLine(upcomingShown !== null && <span data-testid="upcoming-shown">{` · ${upcomingShown}`}</span>)}
        {cappedNote(upcomingOccs)}
        {upcomingFailed && windowError(retryUpcoming)}
        {!upcomingPending && !upcomingFailed && upcomingCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-upcoming-empty">Nothing coming up in the next 30 days.</p>
        )}
        {upcomingCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {upcomingVisible.map((row) => upcomingRow(row))}
          </ul>
        )}
        {upcomingCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={upcomingCount}
              page={upcomingView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('upcoming', { page: next, day: today })}
              label="Upcoming pages"
              testId="due-pager"
              disabled={upcomingPending}
            />
          </div>
        )}
      </>
    ),
    subscriptions: () => (
      <>
        {throughLine(null)}
        {cappedNote(subscriptionOccs)}
        {subscriptionFailed && windowError(() => void subscriptionOccResult.refetch())}
        {!subscriptionPending && !subscriptionFailed && !snapshotError && subscriptionCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-subscriptions-empty">
            No subscription charges due or in the next 30 days.
          </p>
        )}
        {subscriptionCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {subscriptionVisible.map((row) => subscriptionRow(row))}
          </ul>
        )}
        {subscriptionCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={subscriptionCount}
              page={subscriptionView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('subscriptions', { page: next, day: today })}
              label="Subscriptions pages"
              testId="due-pager"
              disabled={subscriptionPending}
            />
          </div>
        )}
      </>
    ),
    installments: () => (
      <>
        {plansFailed && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="due-plans-error">
            <p className="text-sm text-danger" role="alert">Could not load the installment plans.</p>
            <button type="button" onClick={() => void plansResult.refetch()} className={buttonClass} data-testid="due-plans-retry">
              Retry
            </button>
          </div>
        )}
        {!plansPending && !plansFailed && planCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-installments-empty">No active installment plans.</p>
        )}
        {planCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {planVisible.map((plan) => planRow(plan))}
          </ul>
        )}
        {planCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={planCount}
              page={planView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('installments', { page: next, day: today })}
              label="Installments pages"
              testId="due-pager"
              disabled={plansPending}
            />
          </div>
        )}
      </>
    ),
  }

  return (
    <section className="card" data-testid="due-section" data-limited-rows={LIMITED_ROWS} aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">Due and overdue</h2>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls={TABS.map(({ id }) => tabPanelId(id)).join(' ')}
          className={buttonClass}
          data-testid="due-section-toggle"
        >
          {open ? 'Hide' : 'Show'}
        </button>
        <div role="tablist" aria-labelledby={titleId} className="flex min-w-0 flex-1 flex-wrap gap-1 bg-sunken p-1">
          {TABS.map(({ id, label, slug, badgeTestId }, index) => {
            const selectedTab = tab === id
            const badge = badges[id]
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[index] = el
                }}
                type="button"
                role="tab"
                id={tabId(id)}
                aria-selected={selectedTab}
                aria-controls={tabPanelId(id)}
                tabIndex={selectedTab ? 0 : -1}
                onClick={() => selectTab(id)}
                onKeyDown={(event) => onTabKey(event, index)}
                className={`flex flex-auto items-center justify-between gap-2 whitespace-nowrap px-3 py-1.5 text-left text-sm font-medium transition-colors duration-200 focus-ring ${
                  selectedTab ? 'bg-surface text-ink' : 'text-body hover:text-ink'
                }`}
                data-testid={`due-tab-${slug}`}
              >
                <span>{label}</span>
                <span className="badge" data-testid={badgeTestId}>{badge.pending ? '…' : badge.count}</span>
              </button>
            )
          })}
        </div>
      </div>
      {open && snapshotError && (
        <p className="border-t border-line px-4 py-3 text-sm text-danger" role="alert">Could not load what is due.</p>
      )}
      {open && !snapshotError && (windowResult.failed || linkedFailed) && (
        <p className="border-t border-line px-4 py-3 text-sm text-danger" role="alert" data-testid="due-pending-error">
          Could not load some pending transactions.
        </p>
      )}
      {TABS.map(({ id, slug }) => (
        <div
          key={id}
          role="tabpanel"
          id={tabPanelId(id)}
          aria-labelledby={tabId(id)}
          tabIndex={0}
          hidden={!open || tab !== id}
          className="border-t border-line focus-ring"
          data-testid={`due-panel-${slug}`}
        >
          {open && tab === id && panels[id]()}
        </div>
      ))}
      {open && hasMore && selectedUsesWindow && (
        <div className="border-t border-line px-4 py-3">
          <button type="button" onClick={loadMore} className={buttonClass} data-testid="due-load-more">
            Load more
          </button>
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
